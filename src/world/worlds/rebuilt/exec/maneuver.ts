/**
 * Maneuver planner (owner: P1): choose between close-quarters maneuvers with micro-rollouts.
 *
 * When a controller asks for escape_spin or escape_reverse, the planner plays each of the two
 * forward config.microRollouts.count times for config.microRollouts.horizonS seconds (seeds
 * derived from the match state, so the choice is deterministic) and keeps the better one:
 *   1. higher mean score margin for the robot's alliance over the horizon,
 *   2. then more rollouts in which the robot ends free of contact,
 *   3. then a shorter mean distance left to the exit zone.
 * The exit zone the controller asked for is kept; only spin vs reverse is decided here.
 */
import { intentLabel, type Engine, type Intent, type MatchState, type RobotId, type RolloutPolicies, zoneCenter, dist, getRobot } from "../../../../contracts";
import { hashString } from "../../../../util/rng";

/** Settings for micro-rollouts (config.microRollouts). */
export interface MicroRolloutSettings {
  /** Rollouts per candidate. */
  count: number;
  /** Horizon, seconds. */
  horizonS: number;
}

/** How one candidate did. */
export interface CandidateScore {
  /** Option label of the candidate. */
  label: string;
  /** The candidate intent. */
  intent: Intent;
  /** Mean (pointsFor - pointsAgainst) over the rollouts. */
  meanMargin: number;
  /** Fraction of rollouts that ended with the robot out of contact. */
  freeFraction: number;
  /** Mean distance from the robot to its exit point at the end, metres. */
  meanExitDistanceM: number;
}

/** Score each candidate intent for `robotId` with micro-rollouts; deterministic for a state. */
export function scoreCandidates(
  engine: Engine,
  state: MatchState,
  robotId: RobotId,
  candidates: readonly Intent[],
  settings: MicroRolloutSettings,
  policies: RolloutPolicies,
): CandidateScore[] {
  const robot = getRobot(state, robotId);
  const snap = engine.snapshot(state);
  const base = hashString(`${state.seed}:${state.tick}:${robotId}`);
  return candidates.map((intent) => {
    const exit =
      intent.action === "escape_spin" || intent.action === "escape_reverse" ? zoneCenter(state.field, robot.alliance, intent.params.exitToward) : null;
    let margin = 0;
    let free = 0;
    let exitD = 0;
    for (let i = 0; i < settings.count; i++) {
      // Same seeds for every candidate (common random numbers): differences come from the choice.
      const r = engine.rollout(snap, { [robotId]: intent }, settings.horizonS, (base + i) | 0, policies, { perspective: robot.alliance });
      margin += r.pointsFor - r.pointsAgainst;
      const end = getRobot(r.finalSnapshot.state, robotId);
      if (end.contact.withRobotId === null) free += 1;
      if (exit) exitD += dist(end.pose, exit);
    }
    const n = Math.max(1, settings.count);
    return { label: intentLabel(intent), intent, meanMargin: margin / n, freeFraction: free / n, meanExitDistanceM: exitD / n };
  });
}

/** Best candidate by margin, then freedom, then exit distance; ties keep the first. */
export function bestCandidate(scores: readonly CandidateScore[]): CandidateScore | undefined {
  let best: CandidateScore | undefined;
  for (const s of scores) {
    if (
      !best ||
      s.meanMargin > best.meanMargin ||
      (s.meanMargin === best.meanMargin && s.freeFraction > best.freeFraction) ||
      (s.meanMargin === best.meanMargin && s.freeFraction === best.freeFraction && s.meanExitDistanceM < best.meanExitDistanceM)
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * If `intent` is an escape, return the better of escape_spin / escape_reverse toward the same
 * exit (with the same `then` step), chosen by micro-rollouts. Any other intent comes back as is.
 */
export function planManeuver(
  engine: Engine,
  state: MatchState,
  robotId: RobotId,
  intent: Intent,
  settings: MicroRolloutSettings,
  policies: RolloutPolicies,
): { intent: Intent; scores: CandidateScore[] } {
  if (intent.action !== "escape_spin" && intent.action !== "escape_reverse") return { intent, scores: [] };
  const exitToward = intent.params.exitToward;
  const then = intent.then ? { then: intent.then } : {};
  const candidates: Intent[] = [
    { action: "escape_spin", params: { exitToward }, ...then } as Intent,
    { action: "escape_reverse", params: { exitToward }, ...then } as Intent,
  ];
  const scores = scoreCandidates(engine, state, robotId, candidates, settings, policies);
  return { intent: bestCandidate(scores)?.intent ?? intent, scores };
}
