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
  intentLabel,
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
import * as execApi from "../exec";
import { robotsNeedingDecision } from "../exec";
import { PROMPT_VERSION } from "./options";
import { actionQuestionId, buildBatchActionRequest, type OptionPresentation, buildCaptainRequest, captainQuestionId, captainRoleOptions } from "./ask";

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
  /** Called for every scripted-robot decision (applied on the same tick it is made). */
  onScriptedDecision?: (d: { robotId: RobotId; timeS: number; policyId: string; view: ObservationView; intent: Intent }) => void;
  /**
   * Option presentation (default: live play = curated to 10 options with fact-rich descriptions,
   * rules from the match state). Pass { full: true } to offer the full masked list instead.
   */
  options?: { full?: boolean; maxOptions?: number };
  /** Called after every engine step with that step's events and the state after it. */
  onStep?: (events: EngineEvent[], state: MatchState) => void;
  /**
   * Fairness rules, applied identically to every robot whoever decides for it (defaults on;
   * values from state.rules.triggers, each defaulting to the old behaviour when absent):
   *   commitment - hold an intent for minCommitS unless a CRITICAL trigger fires; coalesce
   *                triggers within coalesceS into one decision moment per alliance
   *   noIdle     - a decider-controlled robot idle for maxIdleS while it waits for an answer is
   *                given roleContinuation(view) (logged as decisionKind "role_continuation")
   * Turn either off for the before/after comparison.
   */
  fairness?: { commitment?: boolean; noIdle?: boolean; antiLoop?: boolean };
  /** Called for every role-continuation intent (never counted as the decider's decision). */
  onContinuation?: (d: { robotId: RobotId; timeS: number; view: ObservationView; intent: Intent }) => void;
  /** Checked before every tick; return a reason to stop the match early (e.g. provider blocked). */
  shouldStop?: () => string | null;
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
  /** The provider's probability per option label for this robot's question (null when it gives none or fell back). */
  probabilities: Record<string, number> | null;
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
  /** Behaviour counters per robot. */
  byRobot: Record<RobotId, RobotBehaviour>;
  /** The fairness parameters in force. */
  fairness: FairnessParams;
  /** Why the match stopped early (shouldStop), or null when it ran to the end / untilS. */
  abortedReason: string | null;
}

/** Exact totals for one alliance's decider in one match. */
export interface AllianceTotals {
  /** Controller decisions (provider requests, a captain step counts its sequential calls separately in `calls`). */
  decisions: number;
  /** Provider calls (DecisionRequests sent). */
  calls: number;
  /** Questions asked across those requests. */
  questions: number;
  /**
   * HTTP calls those requests needed: one per request for Drex (all robots deciding on one tick
   * share one call), one per QUESTION for chat providers that split batches (deepinfra default).
   * Parse-retries are not included here; they are in the usage ledger.
   */
  httpCalls: number;
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
  /** Chosen options that ended within failFastS of being applied (anti-loop guard). */
  fastFails: number;
  /** Options put on cool-down. */
  cooledDown: number;
  /** Intents replaced before their action finished (action_done / failed / timeout). */
  interruptedActions: number;
  /** Completed cycles: a finished collect followed by fuel scored by the same robot. */
  completedCycles: number;
  /** Robot-seconds standing with no intent. */
  idleS: number;
  /** Robot-seconds driven by roleContinuation while waiting for the decider. */
  continuationS: number;
  /** Role-continuation intents handed out. */
  continuations: number;
}

/** Per-robot behaviour counters (see AllianceTotals). */
export interface RobotBehaviour {
  decisions: number;
  /** Chosen options that ended (failed, done or timed out) within failFastS of being applied. */
  fastFails: number;
  /** Times an option was put on cool-down for this robot. */
  cooledDown: number;
  interruptedActions: number;
  completedCycles: number;
  idleS: number;
  continuationS: number;
  continuations: number;
}

/** The commitment / no-idle parameters in force (from state.rules.triggers). */
export interface FairnessParams {
  minCommitS: number;
  coalesceS: number;
  criticalPinS: number;
  maxIdleS: number;
  commitment: boolean;
  noIdle: boolean;
  /** Anti-loop guard: an option that ends within failFastS of being applied ... */
  failFastS: number;
  /** ... is withheld from that robot for optionCooldownS ... */
  optionCooldownS: number;
  /** ... or optionCooldownLongS after the same label fast-ended 3 times in a row. */
  optionCooldownLongS: number;
}

const COLLECT_ACTIONS = new Set(["collect", "load_outpost", "steal_fuel"]);
const ROBOT_CRITICAL = new Set(["hopper_full", "hopper_empty", "action_done", "action_failed", "action_timeout"]);
const GLOBAL_CRITICAL = new Set(["hub_shift", "hub_warning", "endgame_start"]);

/** The roleContinuation from src/exec when P1's version is present, else the scripted fallback policy. */
function continuationFn(fallback: (v: ObservationView) => Intent): (v: ObservationView) => Intent {
  const fn = (execApi as unknown as { roleContinuation?: (v: ObservationView) => Intent }).roleContinuation;
  return typeof fn === "function" ? fn : fallback;
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
  readonly fairness: FairnessParams;
  /** Robots with an unserved trigger: when it first arrived and whether any was critical. */
  private readonly due = new Map<RobotId, { sinceS: number; critical: boolean }>();
  private readonly committedAtS = new Map<RobotId, number>();
  private readonly actionOpen = new Map<RobotId, boolean>();
  private readonly fromDecision = new Map<RobotId, boolean>();
  private readonly onContinuation = new Set<RobotId>();
  private readonly idleSince = new Map<RobotId, number>();
  private readonly collected = new Set<RobotId>();
  private readonly behaviour = new Map<RobotId, RobotBehaviour>();
  private continuation!: (v: ObservationView) => Intent;
  // anti-loop guard: label -> cool-down end (match time), per robot; the note for the next request
  private readonly cooldown = new Map<RobotId, Map<string, number>>();
  private readonly loopNote = new Map<RobotId, string>();
  private readonly appliedLabel = new Map<RobotId, string>();
  private readonly fastStreak = new Map<RobotId, { label: string; count: number }>();
  readonly decisions: ControllerDecision[] = [];

  private readonly present: OptionPresentation;

  constructor(private readonly opts: ControllerOptions) {
    this.state = opts.engine.createMatch(opts.cfg, opts.seed, opts.robots);
    this.present = opts.options?.full ? {} : { rules: this.state.rules, maxOptions: opts.options?.maxOptions ?? 10 };
    const t = this.state.rules.triggers as typeof this.state.rules.triggers & {
      minCommitS?: number;
      coalesceS?: number;
      criticalPinS?: number;
      maxIdleS?: number;
      failFastS?: number;
      optionCooldownS?: number;
      optionCooldownLongS?: number;
    };
    const commitment = opts.fairness?.commitment ?? true;
    const noIdle = opts.fairness?.noIdle ?? true;
    this.fairness = {
      commitment,
      noIdle,
      minCommitS: commitment ? (t.minCommitS ?? 0) : 0,
      coalesceS: commitment ? (t.coalesceS ?? 0) : 0,
      criticalPinS: t.criticalPinS ?? Infinity,
      maxIdleS: noIdle ? (t.maxIdleS ?? Infinity) : Infinity,
      failFastS: opts.fairness?.antiLoop === false ? -1 : (t.failFastS ?? 0.5),
      optionCooldownS: t.optionCooldownS ?? 5,
      optionCooldownLongS: t.optionCooldownLongS ?? 15,
    };
    for (const r of this.state.robots) this.behaviour.set(r.id, { decisions: 0, fastFails: 0, cooledDown: 0, interruptedActions: 0, completedCycles: 0, idleS: 0, continuationS: 0, continuations: 0 });
    this.continuation = continuationFn((v) => this.policyFor(v.self.id).decide(v));
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

  /** The robot's view, minus options on anti-loop cool-down (never all of them). */
  private view(robotId: RobotId): ObservationView {
    const v = buildObservationView(this.state, robotId, this.sinceDecision.get(robotId) ?? []);
    const cool = this.cooldown.get(robotId);
    if (!cool || cool.size === 0) return v;
    const now = this.state.timeS;
    for (const [label, until] of cool) if (until <= now + EPS) cool.delete(label);
    const options = v.options.filter((o) => !cool.has(o.label));
    return options.length > 0 && options.length < v.options.length ? { ...v, options } : v;
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

  /** True when `e` is a CRITICAL trigger for robot `id` (breaks the commitment hold). */
  private isCritical(e: EngineEvent, id: RobotId): boolean {
    if (GLOBAL_CRITICAL.has(e.kind)) return true;
    if (!("robotId" in e) || e.robotId !== id) return false;
    if (e.kind === "action_done") return !e.continuesWithThen;
    if (ROBOT_CRITICAL.has(e.kind)) return true;
    return e.kind === "pinned" && e.seconds > this.fairness.criticalPinS;
  }

  /**
   * Anti-loop guard, identical for every decider: a decided option that ends within failFastS of
   * being applied is withheld from that robot for optionCooldownS (optionCooldownLongS after the
   * same label did so 3 times in a row), and the reason goes into its next request.
   */
  private noteActionEnd(e: Extract<EngineEvent, { kind: "action_done" | "action_failed" | "action_timeout" }>): void {
    const id = e.robotId;
    const f = this.fairness;
    const label = this.appliedLabel.get(id);
    if (!label || !this.fromDecision.get(id) || f.failFastS < 0) return;
    const since = this.state.timeS - (this.committedAtS.get(id) ?? -Infinity);
    if (since > f.failFastS + EPS) {
      this.fastStreak.delete(id);
      return;
    }
    const b = this.behaviour.get(id)!;
    b.fastFails += 1;
    const prev = this.fastStreak.get(id);
    const count = prev && prev.label === label ? prev.count + 1 : 1;
    this.fastStreak.set(id, { label, count });
    let cool = this.cooldown.get(id);
    if (!cool) this.cooldown.set(id, (cool = new Map()));
    cool.set(label, this.state.timeS + (count >= 3 ? f.optionCooldownLongS : f.optionCooldownS));
    b.cooledDown += 1;
    const how = e.kind === "action_failed" ? `failed immediately: ${e.reason}` : e.kind === "action_timeout" ? "timed out immediately" : "ended immediately";
    this.loopNote.set(id, `Last action ${label} ${how}.`);
    this.appliedLabel.delete(id); // one end per application
  }

  /** Give a robot an intent chosen by a decider or scripted policy (counts interruptions). */
  private setDecided(id: RobotId, intent: Intent, intents: Record<RobotId, Intent | undefined>): void {
    const b = this.behaviour.get(id)!;
    b.decisions += 1;
    if (this.actionOpen.get(id) && this.fromDecision.get(id) && getRobot(this.state, id).intent !== null) b.interruptedActions += 1;
    intents[id] = intent;
    this.sinceDecision.set(id, []);
    this.committedAtS.set(id, this.state.timeS);
    this.actionOpen.set(id, true);
    this.fromDecision.set(id, true);
    this.onContinuation.delete(id);
    this.due.delete(id);
    this.appliedLabel.set(id, intentLabel(intent));
    if (COLLECT_ACTIONS.has(intent.action)) this.collected.delete(id);
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
      const answer = res.answers[captainQuestionId(robotId)];
      const label = answer?.chosen ?? null;
      const role = !res.meta.fallbackUsed && label ? roleByLabel.get(label) : undefined;
      if (role) assigned[robotId] = role;
      choices.push({ robotId, chosenLabel: role ? label : null, intent: null, ...(role ? { role } : {}), probabilities: role ? (answer?.probabilities ?? null) : null, usedFallbackPolicy: !role });
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
        const notes = Object.fromEntries(group.flatMap((v) => (this.loopNote.has(v.self.id) ? [[v.self.id, [this.loopNote.get(v.self.id)!]]] : [])));
        for (const v of group) this.loopNote.delete(v.self.id);
        const req = buildBatchActionRequest(group, this.nextSeed(), this.requestMode, roles, this.present, notes);
        const res = await agent.provider.decide(req);
        return { group, req, res };
      }),
    );
    return results.map(({ group, req, res }) => {
      const choices: RobotChoice[] = group.map((v) => {
        const answer = res.answers[actionQuestionId(v.self.id)];
        const label = answer?.chosen ?? null;
        const option = label === null ? undefined : v.options.find((o) => o.label === label);
        if (res.meta.fallbackUsed || !option) {
          // The label logged is the fallback policy's intent, never the provider's default answer.
          const intent = this.policyFor(v.self.id).decide(v);
          return { robotId: v.self.id, chosenLabel: intentLabel(intent), intent, probabilities: null, usedFallbackPolicy: true };
        }
        return { robotId: v.self.id, chosenLabel: label, intent: option.intent, probabilities: answer?.probabilities ?? null, usedFallbackPolicy: false };
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
        if (c.intent) this.setDecided(c.robotId, c.intent, intents);
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

    // 3. Triggers -> decision moments, under the commitment rule (identical for every robot):
    //    a non-critical trigger inside the minCommitS hold is ignored; triggers are held for
    //    coalesceS from the first one so all of an alliance's robots are asked in one moment.
    const f = this.fairness;
    for (const id of robotsNeedingDecision(this.state, this.lastEvents)) {
      if (this.busy.has(id) || intents[id] !== undefined) continue;
      const robot = getRobot(this.state, id);
      const critical = robot.intent === null || this.lastEvents.some((e) => this.isCritical(e, id));
      const held = now - (this.committedAtS.get(id) ?? -Infinity) < f.minCommitS - EPS;
      if (!critical && held && !this.onContinuation.has(id)) continue; // ignored during the hold
      const prev = this.due.get(id);
      this.due.set(id, { sinceS: prev?.sinceS ?? now, critical: (prev?.critical ?? false) || critical });
    }
    const byAlliance: Record<Alliance, RobotId[]> = { red: [], blue: [] };
    for (const alliance of ["blue", "red"] as const) {
      const ids = [...this.due.keys()].filter((id) => getRobot(this.state, id).alliance === alliance && !this.busy.has(id) && intents[id] === undefined);
      if (ids.length === 0) continue;
      const first = Math.min(...ids.map((id) => this.due.get(id)!.sinceS));
      if (now < first + f.coalesceS - EPS) continue; // still inside the coalescing window
      for (const id of ids) {
        if (this.opts.agents[alliance]) {
          byAlliance[alliance].push(id);
          this.due.delete(id);
        } else {
          const view = this.view(id);
          const policy = this.policyFor(id);
          const intent = policy.decide(view);
          this.setDecided(id, intent, intents);
          this.opts.onScriptedDecision?.({ robotId: id, timeS: this.state.timeS, policyId: policy.id, view, intent });
        }
      }
    }
    const waitStart = performance.now();
    const asked = await Promise.all(
      (["blue", "red"] as const).filter((a) => byAlliance[a].length > 0).map((a) => this.intentStep(a, this.opts.agents[a]!, byAlliance[a])),
    );
    if (asked.length > 0) this.providerWaitMs += performance.now() - waitStart;
    for (const d of asked.flat()) this.schedule(d, intents);

    // 3b. No-idle rule: a decider-controlled robot standing still for maxIdleS while it waits
    //     (answer pending, or a decision moment not yet due) gets roleContinuation(view); the
    //     decider's answer replaces it when it arrives.
    const dt = this.state.rules.physics.dtS;
    for (const robot of this.state.robots) {
      const id = robot.id;
      const idleNow = robot.intent === null && intents[id] === undefined;
      if (!idleNow) this.idleSince.delete(id);
      else if (!this.idleSince.has(id)) this.idleSince.set(id, now);
      if (idleNow && this.opts.agents[robot.alliance] && now - this.idleSince.get(id)! >= f.maxIdleS - EPS) {
        const view = this.view(id);
        const intent = this.continuation(view);
        intents[id] = intent;
        this.onContinuation.add(id);
        this.fromDecision.set(id, false);
        this.actionOpen.set(id, true);
        this.idleSince.delete(id);
        this.behaviour.get(id)!.continuations += 1;
        this.opts.onContinuation?.({ robotId: id, timeS: now, view, intent });
      }
      const b = this.behaviour.get(id)!;
      if (robot.intent === null && intents[id] === undefined) b.idleS += dt;
      else if (this.onContinuation.has(id)) b.continuationS += dt;
    }

    // 4. Step the engine.
    const { events } = this.opts.engine.step(this.state, intents, this.state.rules.physics.dtS);
    this.ticks += 1;
    this.lastEvents = events;
    this.opts.onStep?.(events, this.state);
    for (const e of events) {
      if (!("robotId" in e) || !e.robotId) continue;
      if ((e.kind === "action_done" && !e.continuesWithThen) || e.kind === "action_failed" || e.kind === "action_timeout") {
        this.noteActionEnd(e);
        this.actionOpen.set(e.robotId, false);
        if (e.kind === "action_done" && COLLECT_ACTIONS.has(e.action)) this.collected.add(e.robotId);
      }
      if (e.kind === "score" && e.source === "fuel" && e.points > 0 && this.collected.has(e.robotId)) {
        this.collected.delete(e.robotId);
        const b = this.behaviour.get(e.robotId);
        if (b) b.completedCycles += 1;
      }
    }
    for (const robot of this.state.robots) {
      const seen = this.sinceDecision.get(robot.id) ?? [];
      seen.push(...events);
      this.sinceDecision.set(robot.id, seen.slice(-50));
    }
  }

  /**
   * Play the match to the end, or until match time `untilS` (tests and short demos). Answers
   * still outstanding when it stops are counted as dropped.
   */
  async run(untilS = Infinity): Promise<ControllerSummary> {
    const started = performance.now();
    let abortedReason: string | null = null;
    while (!this.finished && this.state.timeS < untilS - EPS) {
      abortedReason = this.opts.shouldStop?.() ?? null;
      if (abortedReason) break;
      await this.tick();
    }
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
        questions: ds.reduce((s, d) => s + d.requests.reduce((t, r) => t + r.questions.length, 0), 0),
        httpCalls: (this.opts.agents[a]?.provider as { splitQuestions?: boolean } | undefined)?.splitQuestions
          ? ds.reduce((s, d) => s + d.requests.reduce((t, r) => t + r.questions.length, 0), 0)
          : metas.length,
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
        ...behaviourTotals(a),
      };
    };
    const behaviourTotals = (a: Alliance) => {
      const rs = this.state.robots.filter((r) => r.alliance === a).map((r) => this.behaviour.get(r.id)!);
      const s = (k: keyof RobotBehaviour) => rs.reduce((t, b) => t + b[k], 0);
      return { fastFails: s("fastFails"), cooledDown: s("cooledDown"), interruptedActions: s("interruptedActions"), completedCycles: s("completedCycles"), idleS: s("idleS"), continuationS: s("continuationS"), continuations: s("continuations") };
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
      abortedReason,
      byRobot: Object.fromEntries(this.behaviour),
      fairness: this.fairness,
    };
  }
}

/**
 * Run-log "decision" lines for one controller decision: one line per robot, carrying exactly the
 * request that robot's answer came from and that call's meta. isMock is true when the provider
 * was a mock. Captain decisions log chosenLabel = the role label and intent = null.
 *
 * matchTimeS is the match time the answer was APPLIED (after the charged latency in realtime
 * timing), so a replay that applies each logged intent at its matchTimeS reproduces the match.
 * Answers that arrived after the match ended keep matchTimeS = request time and intent = null.
 *
 * Extra keys beyond the contract (kept by JSON, stripped by a strict schema parse until the
 * contract has them): decisionKind, requestedAtS, appliedAtS, chargedS, probabilities, role,
 * promptVersion.
 */
export function decisionRunEvents(d: ControllerDecision): RunEventBody[] {
  return d.choices.map((c, i) => {
    const k = d.kind === "captain" ? i : 0;
    const meta = d.metas[k]!;
    return {
      type: "decision" as const,
      isMock: meta.isMock,
      robotId: c.robotId,
      matchTimeS: d.appliedAtS ?? d.requestedAtS,
      request: d.requests[k]!,
      meta,
      chosenLabel: c.chosenLabel,
      intent: d.appliedAtS === null ? null : c.intent,
      decisionKind: d.kind,
      requestedAtS: d.requestedAtS,
      appliedAtS: d.appliedAtS,
      chargedS: d.chargedS,
      probabilities: c.probabilities,
      promptVersion: PROMPT_VERSION,
      ...(c.role ? { role: c.role } : {}),
    } as RunEventBody;
  });
}
