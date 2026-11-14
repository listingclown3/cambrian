/**
 * Policy contract: scripted (synchronous, no network) controllers and what they may see.
 *
 * ObservationView is "what a scout in the stands could see": positions, visible fuel, events,
 * the hub timer, and other robots' observed traits. It NEVER contains another robot's profile,
 * intent, `then` step, controller id, or any other secret parameter. The same view is rendered
 * to text for decision models, so this rule also bounds what Drex and the LLMs are told.
 */
import { z } from "zod";
import { AllianceSchema, PoseSchema, RobotIdSchema, VelocitySchema } from "./common";
import { IntentOptionSchema, IntentSchema, type Intent } from "./actions";
import { EngineEventSchema } from "./engine";
import { FieldLayoutSchema, FieldZoneIdSchema } from "./field";
import { AimMethodSchema, RobotProfileSchema, ShooterTypeSchema } from "./profiles";
import { ClimbStateSchema, ContactStateSchema, FuelPileSchema, HubStateSchema, PhaseSchema } from "./state";

/** The traits of a robot that anyone watching it could work out. A strict subset of RobotProfile. */
export const ObservedTraitsSchema = z.object({
  /** Team label painted on the robot. */
  teamLabel: z.string(),
  /** Height class. */
  heightClass: z.enum(["short", "tall"]),
  /** Drivetrain type. */
  drivetrain: z.enum(["swerve", "tank"]),
  /** Shooter mechanism family. */
  shooterType: ShooterTypeSchema,
  /** How it aims. */
  aimMethod: AimMethodSchema,
  /** Number of shooting lanes. */
  lanes: z.number().int(),
  /** Intake width class. */
  intakeWidth: z.enum(["narrow", "wide"]),
  /** Whether it fits under the trench. */
  fitsUnderTrench: z.boolean(),
  /** Whether it has been seen to shoot while moving. */
  shootsOnMove: z.boolean(),
});
export type ObservedTraits = z.infer<typeof ObservedTraitsSchema>;

/** Another robot as seen from outside. */
export const ObservedRobotSchema = z.object({
  /** Robot id. */
  id: RobotIdSchema,
  /** Alliance colour. */
  alliance: AllianceSchema,
  /** True when it is on the observer's alliance. */
  isPartner: z.boolean(),
  /** Position and heading. */
  pose: PoseSchema,
  /** Velocity. */
  velocity: VelocitySchema,
  /** Coarse hopper fullness, as visible from outside. */
  fuelLevel: z.enum(["empty", "partial", "full"]),
  /** The action it visibly appears to be doing (name only, no parameters), or null when idle. */
  apparentAction: z.string().nullable(),
  /** Level it is hanging at on the tower (0 = on the floor). */
  climbLevel: z.number().int().min(0).max(3),
  /** Robot it is in contact with, or null. */
  inContactWith: RobotIdSchema.nullable(),
  /** Outwardly visible traits. */
  traits: ObservedTraitsSchema,
});
export type ObservedRobot = z.infer<typeof ObservedRobotSchema>;

/** The observing robot's knowledge of itself (it knows its own profile and state exactly). */
export const SelfViewSchema = z.object({
  /** Own robot id. */
  id: RobotIdSchema,
  /** Own alliance. */
  alliance: AllianceSchema,
  /** Own full profile. */
  profile: RobotProfileSchema,
  /** Own pose. */
  pose: PoseSchema,
  /** Own velocity. */
  velocity: VelocitySchema,
  /** Fuel in own hopper. */
  fuelHeld: z.number().int().nonnegative(),
  /** Intent currently being executed, or null. */
  intent: IntentSchema.nullable(),
  /** True when aligned to own hub. */
  aligned: z.boolean(),
  /** True when the shooter is at speed. */
  spinUpReady: z.boolean(),
  /** Own contact and pin timers. */
  contact: ContactStateSchema,
  /** Own climb state. */
  climb: ClimbStateSchema,
});
export type SelfView = z.infer<typeof SelfViewSchema>;

export const ObservationViewSchema = z.object({
  /** Match time, seconds. */
  timeS: z.number().nonnegative(),
  /** Current phase. */
  phase: PhaseSchema,
  /** 1-based hub shift index while phase is "shift", otherwise 0. */
  shiftIndex: z.number().int().nonnegative(),
  /** Seconds left in the match. */
  matchRemainingS: z.number().nonnegative(),
  /** Hub timers from the observer's point of view. */
  hubs: z.object({
    /** The observer's own hub. */
    ours: HubStateSchema,
    /** The opponents' hub. */
    theirs: HubStateSchema,
  }),
  /** The observing robot. */
  self: SelfViewSchema,
  /** Every other robot, partners first, then opponents, each in match order. */
  robots: z.array(ObservedRobotSchema),
  /** Fuel visible on the floor. */
  fuel: z.object({
    /** Loose fuel per floor zone. */
    byZone: z.record(FieldZoneIdSchema, z.number().int().nonnegative()),
    /** Visible fuel piles. */
    piles: z.array(FuelPileSchema),
  }),
  /** Scoreboard totals. */
  score: z.object({
    /** The observer's alliance total. */
    ours: z.number(),
    /** The opponents' total. */
    theirs: z.number(),
  }),
  /** Events since this robot's previous decision that concern it or everyone, oldest first. */
  recentEvents: z.array(EngineEventSchema),
  /** The masked options this robot may choose from right now. */
  options: z.array(IntentOptionSchema),
  /** Static field layout (public knowledge). */
  field: FieldLayoutSchema,
});
export type ObservationView = z.infer<typeof ObservationViewSchema>;

/** A synchronous, deterministic controller. Used as a baseline and inside rollouts. */
export interface ScriptedPolicy {
  /** Stable policy id (for example "basic_cycle"). */
  readonly id: string;
  /**
   * Choose an intent. Must be synchronous, must not use randomness outside the view, and should
   * return one of view.options' intents (optionally combined with an allowed `then`).
   */
  decide(view: ObservationView): Intent;
}
