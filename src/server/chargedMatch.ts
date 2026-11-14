/**
 * A match loop that CHARGES decision latency against the match clock (owner: P4).
 *
 * While a decision is "thinking" the match keeps stepping and the robot keeps its old intent;
 * the new intent is applied latencyMs of match time after the request. This is the mechanism
 * the real runner (src/exec) will also implement; until provider-driven matches exist the
 * latencies fed in here are SIMULATED and every stream says so in its hello message.
 */
import { stepLabel, type Alliance, type Config, type Engine, type EngineEvent, type Intent, type MatchRobotSpec, type MatchState, type RobotId, type ScriptedPolicy } from "../contracts";
import { buildObservationView } from "../engine/observe";
import { robotsNeedingDecision } from "../exec";
import type { DecisionNote } from "./protocol";

export interface ChargedOptions {
  /** Alliance whose robots are charged. */
  chargedAlliance: Alliance;
  /** Latency charged per decision for that alliance, ms. The other alliance is never charged. */
  latencyMs: number;
}

export class ChargedMatch {
  readonly state: MatchState;
  private lastEvents: EngineEvent[] = [];
  private readonly since = new Map<RobotId, EngineEvent[]>();
  private readonly pending = new Map<RobotId, { intent: Intent; applyAtS: number; label: string; latencyMs: number }>();
  decisionsMade = 0;
  latencySumMs = 0;
  chargedS = 0;

  constructor(
    private readonly engine: Engine,
    cfg: Config,
    seed: number,
    robots: MatchRobotSpec[],
    private readonly policy: ScriptedPolicy,
    private readonly opts: ChargedOptions,
  ) {
    this.state = engine.createMatch(cfg, seed, robots);
  }

  get finished(): boolean {
    return this.state.phase === "finished";
  }

  thinking(): { robotId: RobotId; untilS: number }[] {
    return [...this.pending].map(([robotId, p]) => ({ robotId, untilS: p.applyAtS }));
  }

  tick(): { events: EngineEvent[]; decisions: DecisionNote[] } {
    const intents: Record<RobotId, Intent | undefined> = {};
    const decisions: DecisionNote[] = [];
    const now = this.state.timeS;
    const alliance = new Map(this.state.robots.map((r) => [r.id, r.alliance]));

    for (const robotId of robotsNeedingDecision(this.state, this.lastEvents)) {
      if (this.pending.has(robotId)) continue;
      const intent = this.policy.decide(buildObservationView(this.state, robotId, this.since.get(robotId) ?? []));
      this.since.set(robotId, []);
      const latencyMs = alliance.get(robotId) === this.opts.chargedAlliance ? this.opts.latencyMs : 0;
      this.pending.set(robotId, { intent, applyAtS: now + latencyMs / 1000, label: stepLabel(intent), latencyMs });
    }
    for (const [robotId, p] of [...this.pending]) {
      if (now + 1e-9 < p.applyAtS) continue;
      intents[robotId] = p.intent;
      this.pending.delete(robotId);
      decisions.push({ robotId, timeS: now, intent: p.intent, label: p.label, latencyMs: p.latencyMs });
      if (alliance.get(robotId) === this.opts.chargedAlliance) {
        this.decisionsMade += 1;
        this.latencySumMs += p.latencyMs;
        this.chargedS += p.latencyMs / 1000;
      }
    }
    const { events } = this.engine.step(this.state, intents, this.state.rules.physics.dtS);
    this.lastEvents = events;
    for (const r of this.state.robots) {
      const seen = this.since.get(r.id) ?? [];
      seen.push(...events);
      this.since.set(r.id, seen.slice(-50));
    }
    return { events, decisions };
  }
}
