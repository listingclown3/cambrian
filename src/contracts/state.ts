/**
 * Match state contract.
 *
 * MatchState is plain JSON: no classes, no Maps, no functions, and it carries the RNG state.
 * `JSON.parse(JSON.stringify(state))` must always be a faithful copy, which is what makes
 * snapshot/restore and rollouts exact.
 */
import { z } from "zod";
import { AllianceSchema, PoseSchema, RobotIdSchema, Vec2Schema, VelocitySchema } from "./common";
import { IntentSchema } from "./actions";
import { PhysicsParamsSchema, ShotModelParamsSchema, TriggerParamsSchema } from "./config";
import { FieldLayoutSchema, FieldZoneIdSchema } from "./field";
import { RobotProfileSchema } from "./profiles";

/** Bump when MatchState changes shape; snapshots with another version must be rejected. */
export const STATE_SCHEMA_VERSION = 1;

/**
 * Match phase.
 *   auto       - autonomous period
 *   transition - start of teleop before the first shift (both hubs active)
 *   shift      - an alternating hub shift; see MatchState.shiftIndex
 *   endgame    - final period (all hubs active)
 *   finished   - match over; step() is a no-op
 */
export const PhaseSchema = z.enum(["auto", "transition", "shift", "endgame", "finished"]);
export type Phase = z.infer<typeof PhaseSchema>;

/** State of one alliance's hub. */
export const HubStateSchema = z.object({
  /** True while fuel scored in this hub is worth points. */
  active: z.boolean(),
  /** Seconds until this hub's active flag next changes (or until the phase ends if it will not). */
  timeToShiftS: z.number().nonnegative(),
  /** True during the deactivation warning window just before an active hub goes inactive. */
  warning: z.boolean(),
});
export type HubState = z.infer<typeof HubStateSchema>;

/** Contact and pin timers for one robot. */
export const ContactStateSchema = z.object({
  /** The robot currently in contact with this one, or null. */
  withRobotId: RobotIdSchema.nullable(),
  /** Seconds of continuous contact with withRobotId. */
  contactS: z.number().nonnegative(),
  /** The opposing robot currently pinning this one, or null. */
  pinnedByRobotId: RobotIdSchema.nullable(),
  /** Seconds this robot has been continuously pinned. */
  pinS: z.number().nonnegative(),
  /**
   * Opponents already called for a tower-protection foul against this robot during their
   * current contact (one call per contact). Optional (additive, P1).
   */
  towerFoulBy: z.array(RobotIdSchema).optional(),
});

/** Hub alignment state for one robot. */
export const AlignmentStateSchema = z.object({
  /** True when the shooter is pointed at the robot's own hub well enough to fire. */
  aligned: z.boolean(),
  /** Seconds of aligning still needed if the robot keeps aligning (0 when aligned). */
  remainingS: z.number().nonnegative(),
});

/** Shooter spin-up state for one robot. */
export const SpinUpStateSchema = z.object({
  /** True when the shooter is at speed. */
  ready: z.boolean(),
  /** Seconds until the shooter is at speed if it keeps spinning up (0 when ready). */
  remainingS: z.number().nonnegative(),
});

/** Tower climb state for one robot. */
export const ClimbStateSchema = z.object({
  /** Level the robot is currently hanging at (0 = on the floor). */
  level: z.number().int().min(0).max(3),
  /** True while a climb is under way. */
  inProgress: z.boolean(),
  /** Level being climbed to while inProgress (0 otherwise). */
  targetLevel: z.number().int().min(0).max(3),
  /** Seconds left until the climb in progress completes. */
  remainingS: z.number().nonnegative(),
});

/** Fractional carry-over for rate-based processes, so integer fuel counts stay exact across ticks. */
export const AccumulatorsSchema = z.object({
  /** Fraction of a fuel ball taken in but not yet counted. */
  intake: z.number(),
  /** Fraction of a shot earned but not yet fired. */
  shot: z.number(),
  /** Fraction of a pass earned but not yet thrown. */
  pass: z.number(),
});

/** Everything about one robot at one instant. */
export const RobotStateSchema = z.object({
  /** Robot id, unique in the match. */
  id: RobotIdSchema,
  /** Alliance colour. */
  alliance: AllianceSchema,
  /** Which controller (decision provider or scripted policy id) drives this robot. */
  controllerId: z.string(),
  /** The robot's full profile. Secret: never shown to other robots' controllers. */
  profile: RobotProfileSchema,
  /** Position and heading. */
  pose: PoseSchema,
  /** Current velocity. */
  velocity: VelocitySchema,
  /** Fuel in the hopper (whole balls). */
  fuelHeld: z.number().int().nonnegative(),
  /** The intent being executed, or null when idle and waiting for a decision. */
  intent: IntentSchema.nullable(),
  /** Which step of the intent is running. */
  intentStage: z.enum(["primary", "then"]),
  /** Match time when the current step started, seconds. */
  intentStartedS: z.number(),
  /** Match time of the last decision applied to this robot, seconds. */
  lastDecisionS: z.number(),
  /** Contact and pin timers. */
  contact: ContactStateSchema,
  /** Alignment to own hub. */
  alignment: AlignmentStateSchema,
  /** Shooter spin-up. */
  spinUp: SpinUpStateSchema,
  /** Tower climb. */
  climb: ClimbStateSchema,
  /**
   * Point the robot is driving to for the current step, fixed when the step starts (so that
   * "cross to the other side" targets do not flip mid-crossing); null when not navigating.
   */
  navTarget: Vec2Schema.nullable(),
  /** Seconds the robot has been trying to move without getting closer to its target. */
  noProgressS: z.number().nonnegative(),
  /** Fractional accumulators for intake, shooting and passing. */
  accum: AccumulatorsSchema,
});
export type RobotState = z.infer<typeof RobotStateSchema>;

/** A fuel ball tracked individually (in flight, or loose and worth following). */
export const TrackedBallSchema = z.object({
  /** Unique ball id. */
  id: z.string(),
  /** Current position. */
  pos: Vec2Schema,
  /** Current velocity, metres per second. */
  vel: Vec2Schema,
  /** What the ball is doing. */
  status: z.enum(["shot", "pass", "loose"]),
  /** Robot that launched it, or null. */
  fromRobotId: RobotIdSchema.nullable(),
  /** Alliance whose hub it was shot at, or null when not a shot. */
  targetHub: AllianceSchema.nullable(),
  /** Seconds until it lands or resolves. */
  etaS: z.number().nonnegative(),
});
export type TrackedBall = z.infer<typeof TrackedBallSchema>;

/** A pile of fuel on the floor (staged by a robot or left by missed shots). */
export const FuelPileSchema = z.object({
  /** Unique pile id. */
  id: z.string(),
  /** Pile centre. */
  pos: Vec2Schema,
  /** Number of balls in the pile. */
  count: z.number().int().nonnegative(),
  /** Floor zone the pile lies in. */
  zone: FieldZoneIdSchema,
  /** Alliance that staged it deliberately, or null for incidental piles. */
  stagedBy: AllianceSchema.nullable(),
});
export type FuelPile = z.infer<typeof FuelPileSchema>;

/** All fuel not inside a robot. */
export const FuelStateSchema = z.object({
  /** Loose fuel counted per floor zone (excludes piles and tracked balls). */
  byZone: z.record(FieldZoneIdSchema, z.number().int().nonnegative()),
  /** Individually tracked balls. */
  balls: z.array(TrackedBallSchema),
  /** Fuel piles. */
  piles: z.array(FuelPileSchema),
});
export type FuelState = z.infer<typeof FuelStateSchema>;

/** Points for one alliance, by source. */
export const ScoreBreakdownSchema = z.object({
  /** Fuel points scored in auto. */
  autoFuel: z.number().nonnegative(),
  /** Fuel points scored in teleop (active hub only). */
  teleopFuel: z.number().nonnegative(),
  /** Tower points earned in auto. */
  autoTower: z.number().nonnegative(),
  /** Tower points earned in teleop/endgame. */
  teleopTower: z.number().nonnegative(),
  /** Points awarded to this alliance because the opponents fouled. */
  foulPoints: z.number().nonnegative(),
  /** Fuel that entered this alliance's hub while it was inactive (worth 0; kept for analysis). */
  fuelInInactiveHub: z.number().int().nonnegative(),
  /** Sum of all point fields above. */
  total: z.number().nonnegative(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

/** One foul that was called. */
export const FoulRecordSchema = z.object({
  /** Match time of the call, seconds. */
  timeS: z.number(),
  /** Rule clause id from the game manual (for example a pinning clause). */
  clauseId: z.string(),
  /** Robot that committed the foul. */
  byRobotId: RobotIdSchema,
  /** Alliance that committed the foul. */
  byAlliance: AllianceSchema,
  /** Severity. */
  severity: z.enum(["minor", "major"]),
  /** Points awarded to the other alliance. */
  pointsToOpponent: z.number().nonnegative(),
});
export type FoulRecord = z.infer<typeof FoulRecordSchema>;

/**
 * The subset of config the engine and maskOptions need at runtime, copied into the state at
 * createMatch. step() takes no config argument, so everything the engine reads while stepping
 * must be here; that is also what lets a snapshot be replayed without the original config file.
 */
export const MatchRulesSchema = z.object({
  /** Autonomous period length, seconds. */
  autoS: z.number().positive(),
  /** Teleop length, seconds (transition + shifts + endgame). */
  teleopS: z.number().positive(),
  /** Transition length at the start of teleop, seconds. */
  transitionS: z.number().nonnegative(),
  /** Length of one hub shift, seconds. */
  shiftS: z.number().positive(),
  /** Number of alternating hub shifts. */
  numShifts: z.number().int().nonnegative(),
  /** Endgame length, seconds. */
  endgameS: z.number().nonnegative(),
  /** Total match length, seconds (autoS + teleopS). */
  matchS: z.number().positive(),
  /** Length of the hub deactivation warning, seconds. */
  hubWarningS: z.number().nonnegative(),
  /** True if the alliance that scored more in auto has its hub inactive in shift 1. */
  autoWinnerInactiveFirst: z.boolean(),
  /** Point values. */
  points: z.object({
    /** Points per fuel in an active hub. */
    fuelActive: z.number(),
    /** Points per fuel in an inactive hub. */
    fuelInactive: z.number(),
    /** Tower points in teleop for levels 1, 2, 3. */
    towerTeleop: z.tuple([z.number(), z.number(), z.number()]),
    /** Tower points for a level 1 climb in auto. */
    towerAutoL1: z.number(),
    /** Points to the opponents for a minor foul. */
    minorFoul: z.number(),
    /** Points to the opponents for a major foul. */
    majorFoul: z.number(),
  }),
  /** Pinning limits. */
  pinning: z.object({
    /** Seconds a robot may pin an opponent before a foul. */
    limitS: z.number().positive(),
    /** Distance the pinning robot must back off to end a pin, metres. */
    releaseDistanceM: z.number().positive(),
    /** Severity of the pinning foul. */
    severity: z.enum(["minor", "major"]),
    /** Rule clause id recorded on the foul. */
    clauseId: z.string(),
  }),
  /**
   * Tower protection (rule G420, manual p.73): no contact with an opponent robot that touches its
   * own tower during the last `lastS` seconds of the match. Optional (additive, P1); absent = not enforced.
   */
  towerProtection: z
    .object({
      /** Rule clause id recorded on the foul. */
      clauseId: z.string(),
      /** Window at the end of the match in which the rule applies, seconds. */
      lastS: z.number().nonnegative(),
      /** Severity of the foul. */
      severity: z.enum(["minor", "major"]),
      /** Tower level whose teleop points go to a victim that is off the ground (1-3). */
      offGroundAwardLevel: z.number().int().min(1).max(3),
    })
    .optional(),
  /** Physics knobs (copy of config.physics). */
  physics: PhysicsParamsSchema,
  /** Shot model knobs (copy of config.shotModel). */
  shotModel: ShotModelParamsSchema,
  /** Trigger thresholds (copy of config.triggers). */
  triggers: TriggerParamsSchema,
});
export type MatchRules = z.infer<typeof MatchRulesSchema>;

/** The complete, serializable state of one match. */
export const MatchStateSchema = z.object({
  /** Must equal STATE_SCHEMA_VERSION. */
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  /** Seed the match was created with. */
  seed: z.number().int(),
  /** Internal state of the pure-rand xoroshiro128+ generator. Advances as the engine draws. */
  rngState: z.array(z.number().int()),
  /** Number of step() calls so far. */
  tick: z.number().int().nonnegative(),
  /** Match time, seconds since the start of auto. */
  timeS: z.number().nonnegative(),
  /** Current phase. */
  phase: PhaseSchema,
  /** 1-based index of the current hub shift while phase is "shift", otherwise 0. */
  shiftIndex: z.number().int().nonnegative(),
  /** The alliance whose hub is inactive in shift 1, decided at the end of auto; null before that. */
  firstInactiveAlliance: AllianceSchema.nullable(),
  /** Hub state per alliance. */
  hubs: z.record(AllianceSchema, HubStateSchema),
  /** All robots, in a fixed order (the engine iterates in this order for determinism). */
  robots: z.array(RobotStateSchema),
  /** All fuel outside robots. */
  fuel: FuelStateSchema,
  /** Score per alliance. */
  score: z.record(AllianceSchema, ScoreBreakdownSchema),
  /** Fouls called so far, oldest first. */
  fouls: z.array(FoulRecordSchema),
  /** Static field layout. */
  field: FieldLayoutSchema,
  /** Runtime rule constants. */
  rules: MatchRulesSchema,
});
export type MatchState = z.infer<typeof MatchStateSchema>;

/**
 * A frozen copy of a match that restore() turns back into an identical MatchState.
 * Stepping two restores of the same snapshot with the same intents gives identical results.
 */
export const SnapshotSchema = z.object({
  /** Must equal STATE_SCHEMA_VERSION. */
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  /** Match time when the snapshot was taken, seconds. */
  takenAtS: z.number().nonnegative(),
  /** Deep copy of the full state, RNG state included. */
  state: MatchStateSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Look up a robot by id; throws if it is not in the match. */
export function getRobot(state: MatchState, robotId: string): RobotState {
  const robot = state.robots.find((r) => r.id === robotId);
  if (!robot) throw new Error(`robot ${robotId} is not in this match`);
  return robot;
}
