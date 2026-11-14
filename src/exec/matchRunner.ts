/**
 * Match runner (owner: P1): the loop that asks controllers for intents when triggers fire and
 * steps the engine.
 *
 * STUB: synchronous scripted controllers only. The real runner must also support asynchronous
 * DecisionProviders with real-time latency charging (config.realtimeLatencyCharging): while a
 * provider is thinking the match keeps stepping and the robot keeps its old intent, and the
 * answer is applied `latencyMs * latencyScale` of match time after the request.
 */
import type { Config, Engine, EngineEvent, Intent, MatchRobotSpec, MatchState, RobotId, RolloutPolicies } from "../contracts";
import { buildObservationView } from "../engine/observe";
import { robotsNeedingDecision } from "./triggers";

/** One decision made by the runner, for logging. */
export interface RunnerDecision {
  /** Robot the decision was for. */
  robotId: RobotId;
  /** Match time of the decision, seconds. */
  timeS: number;
  /** The intent chosen. */
  intent: Intent;
}

/** Result of one runner tick. */
export interface RunnerTick {
  /** State after the tick. */
  state: MatchState;
  /** Engine events from the tick. */
  events: EngineEvent[];
  /** Decisions applied at the start of the tick. */
  decisions: RunnerDecision[];
}

export class MatchRunner {
  readonly state: MatchState;
  private lastEvents: EngineEvent[] = [];
  private readonly sinceDecision = new Map<RobotId, EngineEvent[]>();

  constructor(
    private readonly engine: Engine,
    cfg: Config,
    seed: number,
    robots: MatchRobotSpec[],
    private readonly policies: RolloutPolicies,
  ) {
    this.state = engine.createMatch(cfg, seed, robots);
  }

  /** True once the match is over. */
  get finished(): boolean {
    return this.state.phase === "finished";
  }

  /** Ask controllers that need a decision, then advance one engine tick. */
  tick(): RunnerTick {
    const intents: Record<RobotId, Intent | undefined> = {};
    const decisions: RunnerDecision[] = [];
    for (const robotId of robotsNeedingDecision(this.state, this.lastEvents)) {
      const policy = this.policies.byRobot?.[robotId] ?? this.policies.default;
      const intent = policy.decide(buildObservationView(this.state, robotId, this.sinceDecision.get(robotId) ?? []));
      intents[robotId] = intent;
      decisions.push({ robotId, timeS: this.state.timeS, intent });
      this.sinceDecision.set(robotId, []);
    }
    const { events } = this.engine.step(this.state, intents, this.state.rules.physics.dtS);
    this.lastEvents = events;
    if (events.length > 0) {
      for (const robot of this.state.robots) {
        const seen = this.sinceDecision.get(robot.id) ?? [];
        seen.push(...events);
        this.sinceDecision.set(robot.id, seen.length > 50 ? seen.slice(-50) : seen);
      }
    }
    return { state: this.state, events, decisions };
  }

  /** Run until the match ends; returns the final state and counts. */
  runToEnd(): { state: MatchState; ticks: number; decisions: number; events: number } {
    let ticks = 0;
    let decisions = 0;
    let events = 0;
    while (!this.finished) {
      const tick = this.tick();
      ticks += 1;
      decisions += tick.decisions.length;
      events += tick.events.length;
    }
    return { state: this.state, ticks, decisions, events };
  }
}
