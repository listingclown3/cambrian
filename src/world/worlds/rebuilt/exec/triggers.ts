/**
 * Decision triggers (owner: P1): which engine events mean "ask this robot's controller again".
 */
import type { EngineEvent, EngineEventKind, MatchState, RobotId } from "../../../../contracts";

/** Events addressed to one robot that trigger a new decision for it. */
export const ROBOT_TRIGGER_KINDS: ReadonlySet<EngineEventKind> = new Set([
  "action_done",
  "action_failed",
  "action_timeout",
  "contact_long",
  "pinned",
  "no_progress",
  "path_blocked",
  "hopper_full",
  "hopper_empty",
  "opponent_in_range",
  "watchdog",
]);

/** Events addressed to everyone that trigger a new decision for every robot. */
export const GLOBAL_TRIGGER_KINDS: ReadonlySet<EngineEventKind> = new Set(["hub_shift", "hub_warning", "endgame_start"]);

/** True when this event should make `robotId` decide again. */
export function isTriggerFor(event: EngineEvent, robotId: RobotId): boolean {
  if (GLOBAL_TRIGGER_KINDS.has(event.kind)) return true;
  if (!ROBOT_TRIGGER_KINDS.has(event.kind)) return false;
  if (!("robotId" in event) || event.robotId !== robotId) return false;
  // An action_done that rolls straight into the intent's `then` step needs no decision.
  return !(event.kind === "action_done" && event.continuesWithThen);
}

/** Ids of robots that need a decision now: idle robots, plus robots with a trigger in `events`. */
export function robotsNeedingDecision(state: MatchState, events: readonly EngineEvent[]): RobotId[] {
  return state.robots.filter((r) => r.intent === null || events.some((e) => isTriggerFor(e, r.id))).map((r) => r.id);
}
