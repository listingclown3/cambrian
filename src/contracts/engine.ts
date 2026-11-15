/**
 * Engine contract: the interface the simulation engine implements (owner: P1).
 *
 * Determinism rule: for the same (cfg, seed, robots) and the same sequence of
 * (intents, dtS) calls, step() must produce bit-identical states and events. All randomness
 * comes from MatchState.rngState. No Date.now(), no Math.random(), no iteration over Sets/Maps
 * whose order depends on insertion history outside the state.
 */
import { z } from "zod";
import { AllianceSchema, RobotIdSchema, type Alliance, type RobotId } from "./common";
import type { Intent } from "./actions";
import type { Config } from "./config";
import type { ScriptedPolicy } from "./policy";
import type { RobotProfile } from "./profiles";
import { SnapshotSchema, type MatchState, type Snapshot } from "./state";

const base = {
  /** Match time the event happened, seconds. */
  timeS: z.number().nonnegative(),
};

/**
 * Everything the engine reports. Discriminated on `kind`.
 * Events with a `robotId` are decision triggers for that robot (see src/world/worlds/rebuilt/exec/triggers.ts).
 */
export const EngineEventSchema = z.discriminatedUnion("kind", [
  /** The robot's current action finished successfully. */
  z.object({
    ...base,
    kind: z.literal("action_done"),
    /** Robot whose action finished. */
    robotId: RobotIdSchema,
    /** Name of the action that finished. */
    action: z.string(),
    /** True if the intent's `then` step is now starting (no new decision needed yet). */
    continuesWithThen: z.boolean(),
  }),
  /** The robot's current action cannot be completed. */
  z.object({
    ...base,
    kind: z.literal("action_failed"),
    /** Robot whose action failed. */
    robotId: RobotIdSchema,
    /** Name of the action that failed. */
    action: z.string(),
    /** Short machine-readable reason (for example "source_empty", "no_fuel", "cannot_climb"). */
    reason: z.string(),
  }),
  /** The robot's current action ran longer than triggers.actionTimeoutS. */
  z.object({
    ...base,
    kind: z.literal("action_timeout"),
    /** Robot whose action timed out. */
    robotId: RobotIdSchema,
    /** Name of the action. */
    action: z.string(),
    /** Seconds the action has been running. */
    elapsedS: z.number().nonnegative(),
  }),
  /** Two robots came into contact. Emitted once per robot of the pair. */
  z.object({
    ...base,
    kind: z.literal("contact_start"),
    /** Robot this event is addressed to. */
    robotId: RobotIdSchema,
    /** The other robot in the contact. */
    otherRobotId: RobotIdSchema,
  }),
  /** Contact has lasted longer than triggers.contactLongS. */
  z.object({
    ...base,
    kind: z.literal("contact_long"),
    /** Robot this event is addressed to. */
    robotId: RobotIdSchema,
    /** Seconds of continuous contact. */
    seconds: z.number().nonnegative(),
  }),
  /** The robot is being pinned by an opponent. */
  z.object({
    ...base,
    kind: z.literal("pinned"),
    /** Robot being pinned. */
    robotId: RobotIdSchema,
    /** Seconds it has been pinned. */
    seconds: z.number().nonnegative(),
  }),
  /** The robot is trying to move but has made no progress for triggers.noProgressS. */
  z.object({
    ...base,
    kind: z.literal("no_progress"),
    /** Robot that is stuck. */
    robotId: RobotIdSchema,
    /** Seconds without progress. */
    seconds: z.number().nonnegative(),
  }),
  /** The robot's planned path is blocked. */
  z.object({
    ...base,
    kind: z.literal("path_blocked"),
    /** Robot whose path is blocked. */
    robotId: RobotIdSchema,
    /** Robot doing the blocking, when it is a robot. */
    byRobotId: RobotIdSchema.nullable(),
  }),
  /** The robot's hopper just became full. */
  z.object({ ...base, kind: z.literal("hopper_full"), /** Robot whose hopper filled. */ robotId: RobotIdSchema }),
  /** The robot's hopper just became empty. */
  z.object({ ...base, kind: z.literal("hopper_empty"), /** Robot whose hopper emptied. */ robotId: RobotIdSchema }),
  /** Hub active states changed. Addressed to everyone. */
  z.object({
    ...base,
    kind: z.literal("hub_shift"),
    /** Alliances whose hub is active after the change. */
    activeAlliances: z.array(AllianceSchema),
  }),
  /** A hub will deactivate soon. Addressed to everyone. */
  z.object({
    ...base,
    kind: z.literal("hub_warning"),
    /** Alliance whose hub is about to deactivate. */
    alliance: AllianceSchema,
    /** Seconds until it deactivates. */
    secondsToDeactivate: z.number().nonnegative(),
  }),
  /** Endgame began. Addressed to everyone. */
  z.object({ ...base, kind: z.literal("endgame_start") }),
  /** An opposing robot came within triggers.opponentInRangeM. */
  z.object({
    ...base,
    kind: z.literal("opponent_in_range"),
    /** Robot this event is addressed to. */
    robotId: RobotIdSchema,
    /** The opposing robot that came close. */
    opponentId: RobotIdSchema,
    /** Distance between them, metres. */
    distanceM: z.number().nonnegative(),
  }),
  /** Points were scored. Not a decision trigger. */
  z.object({
    ...base,
    kind: z.literal("score"),
    /** Alliance that scored. */
    alliance: AllianceSchema,
    /** Points added (0 when fuel entered an inactive hub). */
    points: z.number(),
    /** What scored. */
    source: z.enum(["fuel", "tower"]),
    /** Robot responsible, when known. */
    robotId: RobotIdSchema.nullable(),
  }),
  /** A foul was called. */
  z.object({
    ...base,
    kind: z.literal("foul"),
    /** Rule clause id. */
    clauseId: z.string(),
    /** Robot that committed the foul. */
    robotId: RobotIdSchema,
    /** Severity. */
    severity: z.enum(["minor", "major"]),
    /** Points awarded to the other alliance. */
    pointsToOpponent: z.number().nonnegative(),
  }),
  /** The robot has gone triggers.watchdogS without a decision; ask again. */
  z.object({
    ...base,
    kind: z.literal("watchdog"),
    /** Robot that needs a decision. */
    robotId: RobotIdSchema,
    /** Seconds since its last decision. */
    secondsSinceDecision: z.number().nonnegative(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;
export type EngineEventKind = EngineEvent["kind"];

/** One robot entering a match. */
export interface MatchRobotSpec {
  /** The robot's full profile. */
  profile: RobotProfile;
  /** Alliance it plays on. */
  alliance: Alliance;
  /** Controller (provider id or scripted policy id) that drives it. */
  controllerId: string;
}

/** Result of one step. */
export interface StepResult {
  /** The state after the step. May be the same object as the input (see Engine.step). */
  state: MatchState;
  /** Events that happened during the step, in the order they occurred. */
  events: EngineEvent[];
}

/** Policies that drive robots without an override during a rollout. */
export interface RolloutPolicies {
  /** Policy for any robot not listed in byRobot. */
  default: ScriptedPolicy;
  /** Per-robot policies. */
  byRobot?: Record<RobotId, ScriptedPolicy>;
}

/** Optional rollout settings. */
export interface RolloutOptions {
  /**
   * Alliance that "For" refers to in the result. Defaults to the alliance of the overridden
   * robots (which must then all be on one alliance), or "red" when there are no overrides.
   */
  perspective?: Alliance;
}

/** Outcome of one rollout. All four numbers are deltas over the rollout, not match totals. */
export const RolloutResultSchema = z.object({
  /** Points the perspective alliance gained during the rollout, foul points awarded to it included. */
  pointsFor: z.number(),
  /** Points the other alliance gained during the rollout, foul points awarded to it included. */
  pointsAgainst: z.number(),
  /** Number of fouls committed BY the perspective alliance during the rollout. */
  foulsFor: z.number().int().nonnegative(),
  /** Number of fouls committed by the other alliance during the rollout. */
  foulsAgainst: z.number().int().nonnegative(),
  /** Snapshot at the end of the rollout. */
  finalSnapshot: SnapshotSchema,
});
export type RolloutResult = z.infer<typeof RolloutResultSchema>;

/** The engine interface. */
export interface Engine {
  /**
   * Create a match at time 0. Robots are given ids "B1".."Bn" and "R1".."Rn" in the order
   * they appear per alliance, placed in their alliance zone and preloaded with fuel.
   */
  createMatch(cfg: Config, seed: number, robots: MatchRobotSpec[]): MatchState;

  /**
   * Advance the match by dtS seconds.
   * `intents[robotId]` replaces that robot's intent; `undefined` (or a missing key) leaves the
   * current intent running. The engine MAY mutate `state` in place and return it; callers who
   * need the old state must snapshot() first.
   */
  step(state: MatchState, intents: Record<RobotId, Intent | undefined>, dtS: number): StepResult;

  /** Deep-copy the state (RNG state included) into a Snapshot. */
  snapshot(state: MatchState): Snapshot;

  /** Turn a snapshot back into an independent MatchState. The snapshot is not modified. */
  restore(snapshot: Snapshot): MatchState;

  /**
   * Play forward from a snapshot for horizonS seconds without touching the original.
   * The RNG is re-seeded with `seed`, so different seeds give different futures.
   * Robots in `overrides` start with that intent and keep it until it completes; after that,
   * and for every other robot, `policies` choose. The rollout stops early if the match ends.
   */
  rollout(
    snapshot: Snapshot,
    overrides: Record<RobotId, Intent>,
    horizonS: number,
    seed: number,
    policies: RolloutPolicies,
    options?: RolloutOptions,
  ): RolloutResult;
}
