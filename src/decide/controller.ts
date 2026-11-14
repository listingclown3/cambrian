/**
 * AgentController (owner: P2): drives a whole match, asking a DecisionProvider for the intents of
 * the robots it controls whenever a decision trigger fires.
 *
 * It talks to the engine only through the Engine interface and buildObservationView (imported
 * from src/engine), and to the triggers through src/exec, so it runs unchanged on the stub
 * engine today and the real engine later.
 *
 * Per alliance you choose an agent (a provider) or nothing (scripted policies drive it), so a
 * live head-to-head is { blue: drex, red: deepinfra }.
 *
 * Batching: all robots of one alliance that need a decision on the same tick are asked in ONE
 * request (shared state text + one question per robot; see buildBatchActionRequest). Drex
 * answers it in one call; the chat providers split it into concurrent one-question calls.
 *
 * Captain: when enabled, at match start and at every hub_shift the alliance captain assigns a
 * role to each of its robots, sequentially (each question sees the roles already given). The
 * role is then written into that robot's own question until the next shift.
 *
 * Timing:
 *   paused   - the match waits while the provider thinks; the answer applies on the same tick.
 *   realtime - latency is charged against the match clock: the request is built from the state at
 *              match time t, the robot keeps its old intent, and the answer is applied at the
 *              first tick whose start time is >= t + latencyMs * latencyScale / 1000. While a
 *              robot's request is outstanding it is not asked again. Answers still outstanding
 *              when the match ends are never applied (and are counted).
 *              The sim does not advance while a call is in flight (the engine is synchronous); it
 *              is the measured latency, not wall-clock overlap, that is charged, which makes the
 *              accounting exact and reproducible from the logged latencies.
 *
 * Fallbacks: when a provider answer is a fallback (meta.fallbackUsed), the robot is driven by the
 * fallback policy for that decision instead of the provider's default first option, and the
 * decision record says so.
 */
import {
  getRobot,
  type Alliance,
  type CaptainRole,
  type Config,
  type DecisionMeta,
  type DecisionProvider,
  type DecisionRequest,
  type Engine,
  type EngineEvent,
  type Intent,
  type MatchRobotSpec,
  type MatchState,
  type ObservationView,
  type RobotId,
  type RolloutPolicies,
  type RunEventBody,
  type ScriptedPolicy,
} from "../contracts";
import { buildObservationView } from "../engine";
import { robotsNeedingDecision } from "../exec";
import { actionQuestionId, buildBatchActionRequest, buildCaptainRequest, captainQuestionId, captainRoleOptions } from "./ask";

/** Floating-point slack when comparing match times. */
const EPS = 1e-9;

export type TimingMode = "paused" | "realtime";

/** How one alliance is controlled by a provider. */
export interface AllianceAgent {
  /** The provider that decides for this alliance's robots. */
  provider: DecisionProvider;
  /** Run the sequential captain step at match start and every hub shift (default false). */
  captain?: boolean;
  /** Batch the robots that need a decision on one tick into one request (default true). */
  batch?: boolean;
}

export interface ControllerOptions {
  engine: Engine;
  cfg: Config;
  seed: number;
  robots: MatchRobotSpec[];
  /** Provider-controlled alliances. An alliance without an entry is scripted. */
  agents: Partial<Record<Alliance, AllianceAgent>>;
  /** Scripted policies for scripted robots, and the fallback policy when a provider fails. */
  scripted: RolloutPolicies;
  /** "paused" (default) or "realtime" (latency charged against the match clock). */
  timing?: TimingMode;
  /** Multiplier on measured latency in realtime mode (default cfg.realtimeLatencyCharging.latencyScale). */
  latencyScale?: number;
  /** DecisionRequest.mode for provider calls (default "live"). */
  requestMode?: DecisionRequest["mode"];
  /** Called once per decision record when it is final (applied, or dropped at match end). */
  onDecision?: (d: ControllerDecision) => void;
}

/** One robot's part of a decision. */
export interface RobotChoice {
  robotId: RobotId;
  /** Label the provider chose (null when it chose nothing usable). */
  chosenLabel: string | null;
  /** The intent handed to the engine (null for captain decisions and dropped answers). */
  intent: Intent | null;
  /** The captain role assigned (captain decisions only). */
  role?: CaptainRole;
  /** True when this robot's intent came from the fallback policy, not the provider. */
  usedFallbackPolicy: boolean;
}

/** One provider call (or one sequential captain step) and when its answer took effect. */
export interface ControllerDecision {
  kind: "intent" | "captain";
  alliance: Alliance;
  /** Match time the request was built at, seconds. */
  requestedAtS: number;
  /** Provider-measured wall-clock latency, milliseconds (sum over sequential captain calls). */
  latencyMs: number;
  /** Match seconds charged for the latency (0 in paused mode). */
  chargedS: number;
  /** Match time the answer took effect (start of that tick), or null if the match ended first. */
  appliedAtS: number | null;
  /** The requests sent (one, or one per robot for the captain step). */
  requests: DecisionRequest[];
  /** Provider bookkeeping for each request. */
  metas: DecisionMeta[];
  choices: RobotChoice[];
}

/** Totals for one match. */
export interface ControllerSummary {
  state: MatchState;
  ticks: number;
  decisions: ControllerDecision[];
  /** Provider calls made, per alliance. */
  calls: Record<Alliance, number>;
  /** Robot decisions answered by a fallback, per alliance. */
  fallbacks: Record<Alliance, number>;
  /** Decisions whose answer arrived after the match ended (realtime only). */
  dropped: number;
  /** Sum of charged match seconds, per alliance. */
  chargedS: Record<Alliance, number>;
  /** Exact per-alliance totals for this match (see AllianceTotals). */
  byAlliance: Record<Alliance, AllianceTotals>;
  /** Wall-clock milliseconds for the whole match (run() start to end). */
  wallMs: number;
  /** Wall-clock milliseconds spent waiting on providers (both alliances' calls overlap, counted once). */
  providerWaitMs: number;
  /** wallMs - providerWaitMs: engine, views, prompts and bookkeeping. */
  simWallMs: number;
  /** Matches per hour at this match's wall time (3,600,000 / wallMs). */
  matchesPerHour: number;
}

/** Exact totals for one alliance's decider in one match. */
export interface AllianceTotals {
  /** Controller decisions (provider requests, a captain step counts its sequential calls separately in `calls`). */
  decisions: number;
  /** Provider calls (DecisionRequests sent). */
  calls: number;
  /** Robot decisions made (intent choices + captain role choices). */
  robotDecisions: number;
  /** Robot decisions answered by the fallback policy. */
  fallbacks: number;
  /** Calls answered from the offline cache. */
  cachedCalls: number;
  /** Sum of provider-measured latency over calls, milliseconds. */
  latencyMs: number;
  /** Sum of match seconds charged for latency (0 in paused mode). */
  chargedS: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Distinct model ids that answered. */
  models: string[];
  /** True if any answer was synthetic (mock). */
  isMock: boolean;
}

interface Pending {
  decision: ControllerDecision;
  applyAtS: number;
}

export class AgentController {
  readonly state: MatchState;
  readonly timing: TimingMode;
  private readonly latencyScale: number;
  private readonly requestMode: DecisionRequest["mode"];
  private lastEvents: EngineEvent[] = [];
  private readonly sinceDecision = new Map<RobotId, EngineEvent[]>();
  private readonly pending: Pending[] = [];
  private readonly busy = new Set<RobotId>();
  private readonly roles = new Map<RobotId, CaptainRole>();
  private captainDue: Record<Alliance, boolean> = { red: true, blue: true };
  private captainBusy: Record<Alliance, boolean> = { red: false, blue: false };
  private calls = 0;
  private ticks = 0;
  private providerWaitMs = 0;
  readonly decisions: ControllerDecision[] = [];

  constructor(private readonly opts: ControllerOptions) {
    this.state = opts.engine.createMatch(opts.cfg, opts.seed, opts.robots);
    this.timing = opts.timing ?? "paused";
    this.latencyScale = opts.latencyScale ?? opts.cfg.realtimeLatencyCharging.latencyScale;
    this.requestMode = opts.requestMode ?? "live";
  }

  get finished(): boolean {
    return this.state.phase === "finished";
  }

  private policyFor(robotId: RobotId): ScriptedPolicy {
    return this.opts.scripted.byRobot?.[robotId] ?? this.opts.scripted.default;
  }

  private view(robotId: RobotId): ObservationView {
    return buildObservationView(this.state, robotId, this.sinceDecision.get(robotId) ?? []);
  }

  private nextSeed(): number {
    this.calls += 1;
    return (this.opts.seed * 1_000_003 + this.calls) | 0;
  }

  private finalize(d: ControllerDecision): void {
    this.decisions.push(d);
    this.opts.onDecision?.(d);
  }

  /** Charge a latency: returns [chargedS, applyAtS]. */
  private charge(requestedAtS: number, latencyMs: number): [number, number] {
    if (this.timing === "paused") return [0, requestedAtS];
    const chargedS = (latencyMs * this.latencyScale) / 1000;
    return [chargedS, requestedAtS + chargedS];
  }

  /** Sequential captain step for one alliance. Returns the decision (roles not yet applied). */
  private async captainStep(alliance: Alliance, provider: DecisionProvider, robotIds: RobotId[]): Promise<ControllerDecision> {
    const requestedAtS = this.state.timeS;
    const views = robotIds.map((id) => this.view(id));
    const assigned: Record<RobotId, CaptainRole> = {};
    const requests: DecisionRequest[] = [];
    const metas: DecisionMeta[] = [];
    const choices: RobotChoice[] = [];
    let latencyMs = 0;
    const opponents = views[0]!.robots.filter((r) => !r.isPartner).map((r) => r.id).sort();
    const roleByLabel = new Map(captainRoleOptions(opponents).map((o) => [o.option.label, o.role]));
    for (const robotId of robotIds) {
      const req = buildCaptainRequest(views, robotId, assigned, this.nextSeed(), this.requestMode);
      const res = await provider.decide(req);
      requests.push(req);
      metas.push(res.meta);
      latencyMs += res.meta.latencyMs;
      const label = res.answers[captainQuestionId(robotId)]?.chosen ?? null;
      const role = !res.meta.fallbackUsed && label ? roleByLabel.get(label) : undefined;
      if (role) assigned[robotId] = role;
      choices.push({ robotId, chosenLabel: role ? label : null, intent: null, ...(role ? { role } : {}), usedFallbackPolicy: !role });
    }
    const [chargedS] = this.charge(requestedAtS, latencyMs);
    return { kind: "captain", alliance, requestedAtS, latencyMs, chargedS, appliedAtS: null, requests, metas, choices };
  }

  /** One intent request for some robots of one alliance. */
  private async intentStep(alliance: Alliance, agent: AllianceAgent, robotIds: RobotId[]): Promise<ControllerDecision[]> {
    const requestedAtS = this.state.timeS;
    const views = robotIds.map((id) => this.view(id));
    const groups = agent.batch === false ? views.map((v) => [v]) : [views];
    const roles = Object.fromEntries(robotIds.map((id) => [id, this.roles.get(id)]));
    const results = await Promise.all(
      groups.map(async (group) => {
        const req = buildBatchActionRequest(group, this.nextSeed(), this.requestMode, roles);
        const res = await agent.provider.decide(req);
        return { group, req, res };
      }),
    );
    return results.map(({ group, req, res }) => {
      const choices: RobotChoice[] = group.map((v) => {
        const label = res.answers[actionQuestionId(v.self.id)]?.chosen ?? null;
        const option = label === null ? undefined : v.options.find((o) => o.label === label);
        if (res.meta.fallbackUsed || !option) {
          return { robotId: v.self.id, chosenLabel: option ? label : null, intent: this.policyFor(v.self.id).decide(v), usedFallbackPolicy: true };
        }
        return { robotId: v.self.id, chosenLabel: label, intent: option.intent, usedFallbackPolicy: false };
      });
      const [chargedS] = this.charge(requestedAtS, res.meta.latencyMs);
      return { kind: "intent" as const, alliance, requestedAtS, latencyMs: res.meta.latencyMs, chargedS, appliedAtS: null, requests: [req], metas: [res.meta], choices };
    });
  }

  /** Apply a decision at the current tick: intents go into `intents`, roles into the role map. */
  private apply(d: ControllerDecision, intents: Record<RobotId, Intent | undefined>): void {
    d.appliedAtS = this.state.timeS;
    for (const c of d.choices) {
      if (d.kind === "captain") {
        if (c.role) this.roles.set(c.robotId, c.role);
        else this.roles.delete(c.robotId);
      } else {
        if (c.intent) {
          intents[c.robotId] = c.intent;
          this.sinceDecision.set(c.robotId, []);
        }
        this.busy.delete(c.robotId);
      }
    }
    if (d.kind === "captain") this.captainBusy[d.alliance] = false;
    this.finalize(d);
  }

  private schedule(d: ControllerDecision, intents: Record<RobotId, Intent | undefined>): void {
    if (this.timing === "paused" || d.chargedS <= EPS) {
      this.apply(d, intents);
      return;
    }
    for (const c of d.choices) if (d.kind === "intent") this.busy.add(c.robotId);
    if (d.kind === "captain") this.captainBusy[d.alliance] = true;
    this.pending.push({ decision: d, applyAtS: d.requestedAtS + d.chargedS });
  }

  /** Ask whoever needs a decision, apply due answers, then advance one engine tick. */
  async tick(): Promise<void> {
    if (this.finished) return;
    const now = this.state.timeS;
    const intents: Record<RobotId, Intent | undefined> = {};

    // 1. Answers whose charged latency has elapsed take effect now, in request order.
    for (let i = 0; i < this.pending.length; ) {
      const p = this.pending[i]!;
      if (p.applyAtS <= now + EPS) {
        this.pending.splice(i, 1);
        this.apply(p.decision, intents);
      } else i++;
    }

    // 2. Captain step on match start and hub shifts.
    if (this.lastEvents.some((e) => e.kind === "hub_shift")) this.captainDue = { red: true, blue: true };
    for (const alliance of ["blue", "red"] as const) {
      const agent = this.opts.agents[alliance];
      if (!agent?.captain || !this.captainDue[alliance] || this.captainBusy[alliance]) continue;
      this.captainDue[alliance] = false;
      const ids = this.state.robots.filter((r) => r.alliance === alliance).map((r) => r.id);
      const waitStart = performance.now();
      const captainDecision = await this.captainStep(alliance, agent.provider, ids);
      this.providerWaitMs += performance.now() - waitStart;
      this.schedule(captainDecision, intents);
    }

    // 3. Robots that need a decision (not already thinking, not just given an intent).
    const needing = robotsNeedingDecision(this.state, this.lastEvents).filter((id) => !this.busy.has(id) && intents[id] === undefined);
    const byAlliance: Record<Alliance, RobotId[]> = { red: [], blue: [] };
    for (const id of needing) {
      const robot = getRobot(this.state, id);
      if (this.opts.agents[robot.alliance]) byAlliance[robot.alliance].push(id);
      else {
        intents[id] = this.policyFor(id).decide(this.view(id));
        this.sinceDecision.set(id, []);
      }
    }
    const waitStart = performance.now();
    const asked = await Promise.all(
      (["blue", "red"] as const).filter((a) => byAlliance[a].length > 0).map((a) => this.intentStep(a, this.opts.agents[a]!, byAlliance[a])),
    );
    if (asked.length > 0) this.providerWaitMs += performance.now() - waitStart;
    for (const d of asked.flat()) this.schedule(d, intents);

    // 4. Step the engine.
    const { events } = this.opts.engine.step(this.state, intents, this.state.rules.physics.dtS);
    this.ticks += 1;
    this.lastEvents = events;
    for (const robot of this.state.robots) {
      const seen = this.sinceDecision.get(robot.id) ?? [];
      seen.push(...events);
      this.sinceDecision.set(robot.id, seen.slice(-50));
    }
  }

  /** Play the match to the end. */
  async run(): Promise<ControllerSummary> {
    const started = performance.now();
    while (!this.finished) await this.tick();
    const wallMs = performance.now() - started;
    const dropped = this.pending.splice(0);
    for (const p of dropped) this.finalize(p.decision); // appliedAtS stays null
    const zero = (): Record<Alliance, number> => ({ red: 0, blue: 0 });
    const calls = zero();
    const fallbacks = zero();
    const chargedS = zero();
    for (const d of this.decisions) {
      calls[d.alliance] += d.metas.length;
      chargedS[d.alliance] += d.chargedS;
      fallbacks[d.alliance] += d.choices.filter((c) => c.usedFallbackPolicy).length;
    }
    const totals = (a: Alliance): AllianceTotals => {
      const ds = this.decisions.filter((d) => d.alliance === a);
      const metas = ds.flatMap((d) => d.metas);
      const sum = (f: (m: DecisionMeta) => number) => metas.reduce((s, m) => s + f(m), 0);
      return {
        decisions: ds.length,
        calls: metas.length,
        robotDecisions: ds.reduce((s, d) => s + d.choices.length, 0),
        fallbacks: fallbacks[a],
        cachedCalls: metas.filter((m) => m.cached).length,
        latencyMs: sum((m) => m.latencyMs),
        chargedS: chargedS[a],
        inputTokens: sum((m) => m.inputTokens),
        outputTokens: sum((m) => m.outputTokens),
        costUsd: sum((m) => m.costUsd),
        models: [...new Set(metas.map((m) => m.model))],
        isMock: metas.some((m) => m.isMock),
      };
    };
    return {
      state: this.state,
      ticks: this.ticks,
      decisions: this.decisions,
      calls,
      fallbacks,
      dropped: dropped.length,
      chargedS,
      byAlliance: { blue: totals("blue"), red: totals("red") },
      wallMs,
      providerWaitMs: this.providerWaitMs,
      simWallMs: Math.max(0, wallMs - this.providerWaitMs),
      matchesPerHour: wallMs > 0 ? 3_600_000 / wallMs : Infinity,
    };
  }
}

/**
 * Run-log "decision" lines for one controller decision: one line per robot, carrying exactly the
 * request that robot's answer came from and that call's meta. isMock is true when the provider
 * was a mock. Captain decisions log chosenLabel = the role label and intent = null.
 */
export function decisionRunEvents(d: ControllerDecision): RunEventBody[] {
  return d.choices.map((c, i) => {
    const k = d.kind === "captain" ? i : 0;
    const meta = d.metas[k]!;
    return {
      type: "decision" as const,
      isMock: meta.isMock,
      robotId: c.robotId,
      matchTimeS: d.requestedAtS,
      request: d.requests[k]!,
      meta,
      chosenLabel: c.chosenLabel,
      intent: d.appliedAtS === null ? null : c.intent,
    };
  });
}
