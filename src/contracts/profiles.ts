/**
 * Robot profile contract: everything that makes one robot different from another.
 *
 * A RobotProfile is the robot's "secret parameters". The engine reads all of it; other robots'
 * controllers only ever see the ObservedTraits subset (see policy.ts).
 *
 * Archetype templates (ranges) live in config/default.json; data/league/ holds sampled teams.
 */
import { z } from "zod";

/** The nine robot archetypes the league is sampled from. */
export const ArchetypeSchema = z.enum([
  "drum_fixed",
  "turret_sotm",
  "multilane_fixed",
  "big_hopper_hauler",
  "dumper",
  "zero_hopper_turret",
  "feeder_passer",
  "defender",
  "starter_bot",
]);
export type Archetype = z.infer<typeof ArchetypeSchema>;
export const ARCHETYPES = ArchetypeSchema.options;

/** Shooter mechanism family. "none" means the robot cannot score fuel at all. */
export const ShooterTypeSchema = z.enum(["drum", "lanes", "turret", "dumper", "none"]);
export type ShooterType = z.infer<typeof ShooterTypeSchema>;

/** How the robot points its shot: by rotating the whole drivetrain, or with a turret. */
export const AimMethodSchema = z.enum(["drivetrain", "turret"]);
export type AimMethod = z.infer<typeof AimMethodSchema>;

/** One row of the shoot-on-the-move accuracy table. */
export const SotmAccuracyRowSchema = z.object({
  /** Robot ground speed while shooting, metres per second. */
  speedMps: z.number().nonnegative(),
  /** Multiplier (0..1) applied to the stationary accuracy at this speed. */
  accuracy: z.number().min(0).max(1),
});

/** One row of the shot accuracy by distance table. */
export const ShotAccuracyRowSchema = z.object({
  /** Distance from the robot to the hub centre, metres. */
  distanceM: z.number().nonnegative(),
  /** Probability (0..1) that one stationary, aligned shot from this distance scores. */
  accuracy: z.number().min(0).max(1),
});

export const RobotProfileSchema = z.object({
  // ── identity ──────────────────────────────────────────────────────────────
  /** Stable profile id, unique within the league (for example "team_017"). */
  id: z.string().min(1),
  /** Human-readable team label shown in the UI and in prompts (for example "Team 17"). */
  teamLabel: z.string().min(1),
  /** Which archetype template this profile was sampled from. */
  archetype: ArchetypeSchema,

  // ── shooter ───────────────────────────────────────────────────────────────
  /** Shooter mechanism family. */
  shooterType: ShooterTypeSchema,
  /** Number of parallel shooting lanes, 1–4. Drum and dumper count as their effective lane count. */
  lanes: z.number().int().min(1).max(4),
  /** Whether the robot aims by turning the drivetrain or with a turret. */
  aimMethod: AimMethodSchema,
  /** Total fuel fired per second across all lanes (typical range 1–10+). */
  fireRatePerS: z.number().nonnegative(),
  /** Seconds for the shooter to reach speed from rest. */
  spinUpS: z.number().nonnegative(),
  /** Seconds to re-set the hood when the shot distance changes. */
  hoodAdjustS: z.number().nonnegative(),
  /** Seconds to align the drivetrain to the hub (drivetrain aim only; 0 for turrets). */
  alignTimeS: z.number().nonnegative(),
  /** Turret slew rate, degrees per second (0 when there is no turret). */
  turretSlewDegPerS: z.number().nonnegative(),
  /** True if the robot can score while driving. */
  shootOnMove: z.boolean(),
  /** Accuracy multiplier by ground speed while shooting on the move, sorted by speed. */
  sotmAccuracyBySpeed: z.array(SotmAccuracyRowSchema),
  /** Stationary shot accuracy by distance to the hub, sorted by distance. */
  shotAccuracyByDistance: z.array(ShotAccuracyRowSchema),
  /** Closest distance to the hub centre the robot can score from, metres. */
  minShotDistanceM: z.number().nonnegative(),
  /** Farthest distance it can score from, metres. For dumpers this is roughly "adjacent to the hub". */
  maxShotDistanceM: z.number().nonnegative(),

  // ── storage and intake ────────────────────────────────────────────────────
  /** Maximum fuel the hopper holds. */
  capacity: z.number().int().nonnegative(),
  /** Fuel collected per second while driving through loose fuel. */
  intakeRatePerS: z.number().nonnegative(),
  /** Intake width class; wide intakes sweep more floor per pass. */
  intakeWidth: z.enum(["narrow", "wide"]),
  /** True if the robot can intake and shoot at the same time. */
  canCollectWhileShooting: z.boolean(),
  /** True if the robot can collect fuel while crossing a bump. */
  canIntakeOverBump: z.boolean(),

  // ── drive ─────────────────────────────────────────────────────────────────
  /** Top speed with an empty hopper, metres per second. */
  speedEmptyMps: z.number().positive(),
  /** Top speed with a full hopper, metres per second. */
  speedFullMps: z.number().positive(),
  /** Acceleration with an empty hopper, metres per second squared. */
  accelEmpty: z.number().positive(),
  /** Acceleration with a full hopper, metres per second squared. */
  accelFull: z.number().positive(),
  /** Robot mass with an empty hopper, kilograms (bumpers and battery included). */
  massEmptyKg: z.number().positive(),
  /** Mass of one fuel ball, kilograms (0.23). Stored on the profile so mass maths is self-contained. */
  fuelMassKg: z.number().positive(),
  /** Wheel/carpet traction coefficient (dimensionless, about 1.0–1.3). */
  traction: z.number().positive(),
  /** Drivetrain type. Tank drives cannot strafe. */
  drivetrain: z.enum(["swerve", "tank"]),
  /** Peak pushing force in a shoving match, newtons. */
  pushForceN: z.number().nonnegative(),

  // ── size ──────────────────────────────────────────────────────────────────
  /** Height class. Tall robots are easier to defend against (their shots are easier to block). */
  heightClass: z.enum(["short", "tall"]),
  /** True if the robot is low enough to drive under the trench. */
  fitsUnderTrench: z.boolean(),

  // ── passing and climbing ──────────────────────────────────────────────────
  /** Maximum distance the robot can pass fuel to a partner or zone, metres (0 = cannot pass). */
  passRangeM: z.number().nonnegative(),
  /** Fuel passed per second. */
  passRatePerS: z.number().nonnegative(),
  /** Highest tower level the robot can climb, 0–3 (0 = cannot climb). */
  climbLevel: z.number().int().min(0).max(3),
  /**
   * Seconds to complete a climb to the robot's own top level once it is at the tower.
   * A lower level L takes climbTimeS * L / climbLevel (see climbTimeForLevel).
   */
  climbTimeS: z.number().nonnegative(),
});
export type RobotProfile = z.infer<typeof RobotProfileSchema>;

/** Seconds this robot needs at the tower to reach `level`. Infinity if it cannot reach it. */
export function climbTimeForLevel(profile: RobotProfile, level: number): number {
  if (level < 1 || level > profile.climbLevel) return Infinity;
  return (profile.climbTimeS * level) / profile.climbLevel;
}

/** Robot mass including the fuel it is carrying, kilograms. */
export function loadedMassKg(profile: RobotProfile, fuelHeld: number): number {
  return profile.massEmptyKg + fuelHeld * profile.fuelMassKg;
}

// ── archetype templates (config) ─────────────────────────────────────────────

/** Closed numeric range [min, max] that the league sampler draws uniformly from. */
export const RangeSchema = z.tuple([z.number(), z.number()]).refine(([lo, hi]) => lo <= hi, "range must be [min, max]");
export type Range = z.infer<typeof RangeSchema>;

/**
 * Template for one archetype. Numeric fields are ranges; boolean traits are probabilities.
 * ALL template numbers are FABRICATED (plausible guesses, not measured from real robots).
 */
export const ArchetypeTemplateSchema = z.object({
  /** One-line plain-English description of the archetype. */
  description: z.string(),
  /** Fixed shooter family for the archetype. */
  shooterType: ShooterTypeSchema,
  /** Fixed aim method for the archetype. */
  aimMethod: AimMethodSchema,
  /** Range for lanes (rounded to an integer when sampled). */
  lanes: RangeSchema,
  /** Range for fireRatePerS. */
  fireRatePerS: RangeSchema,
  /** Range for spinUpS. */
  spinUpS: RangeSchema,
  /** Range for hoodAdjustS. */
  hoodAdjustS: RangeSchema,
  /** Range for alignTimeS. */
  alignTimeS: RangeSchema,
  /** Range for turretSlewDegPerS. */
  turretSlewDegPerS: RangeSchema,
  /** Fixed shootOnMove capability. */
  shootOnMove: z.boolean(),
  /** Base shoot-on-the-move table, copied to the profile unchanged. */
  sotmAccuracyBySpeed: z.array(SotmAccuracyRowSchema),
  /** Base accuracy-by-distance table, multiplied by the sampled accuracyScale (clamped to 1). */
  shotAccuracyByDistance: z.array(ShotAccuracyRowSchema),
  /** Range for the per-team multiplier applied to shotAccuracyByDistance. */
  accuracyScale: RangeSchema,
  /** Range for minShotDistanceM. */
  minShotDistanceM: RangeSchema,
  /** Range for maxShotDistanceM. */
  maxShotDistanceM: RangeSchema,
  /** Range for capacity (rounded to an integer). */
  capacity: RangeSchema,
  /** Range for intakeRatePerS. */
  intakeRatePerS: RangeSchema,
  /** Probability that the intake is wide. */
  wideIntakeProbability: z.number().min(0).max(1),
  /** Probability that the robot can collect while shooting. */
  canCollectWhileShootingProbability: z.number().min(0).max(1),
  /** Probability that the robot can intake over a bump. */
  canIntakeOverBumpProbability: z.number().min(0).max(1),
  /** Range for speedEmptyMps. */
  speedEmptyMps: RangeSchema,
  /** Range for the full-hopper speed as a fraction of speedEmptyMps. */
  speedFullFraction: RangeSchema,
  /** Range for accelEmpty. */
  accelEmpty: RangeSchema,
  /** Range for the full-hopper acceleration as a fraction of accelEmpty. */
  accelFullFraction: RangeSchema,
  /** Range for massEmptyKg. */
  massEmptyKg: RangeSchema,
  /** Range for traction. */
  traction: RangeSchema,
  /** Probability that the drivetrain is swerve (otherwise tank). */
  swerveProbability: z.number().min(0).max(1),
  /** Range for pushForceN. */
  pushForceN: RangeSchema,
  /** Probability that the robot is tall. */
  tallProbability: z.number().min(0).max(1),
  /** Probability that the robot fits under the trench. */
  fitsUnderTrenchProbability: z.number().min(0).max(1),
  /** Range for passRangeM. */
  passRangeM: RangeSchema,
  /** Range for passRatePerS. */
  passRatePerS: RangeSchema,
  /** Range for climbLevel (rounded to an integer, clamped 0–3). */
  climbLevel: RangeSchema,
  /** Range for climbTimeS. */
  climbTimeS: RangeSchema,
});
export type ArchetypeTemplate = z.infer<typeof ArchetypeTemplateSchema>;

/**
 * Build a concrete profile from a template.
 *
 * `uniform` returns numbers in [0, 1). Pass `() => 0.5` for the deterministic midpoint robot,
 * or a seeded generator to sample a league team. It is called once per sampled field, in a
 * fixed order, so the same generator state always yields the same profile.
 */
export function profileFromTemplate(
  archetype: Archetype,
  tpl: ArchetypeTemplate,
  identity: { id: string; teamLabel: string },
  fuelMassKg: number,
  uniform: () => number = () => 0.5,
): RobotProfile {
  const num = ([lo, hi]: Range) => lo + (hi - lo) * uniform();
  const int = (r: Range) => Math.round(num(r));
  const flip = (p: number) => uniform() < p;
  const round = (v: number, places = 2) => Number(v.toFixed(places));

  const accuracyScale = num(tpl.accuracyScale);
  const speedEmptyMps = num(tpl.speedEmptyMps);
  const accelEmpty = num(tpl.accelEmpty);

  return RobotProfileSchema.parse({
    id: identity.id,
    teamLabel: identity.teamLabel,
    archetype,
    shooterType: tpl.shooterType,
    lanes: Math.min(4, Math.max(1, int(tpl.lanes))),
    aimMethod: tpl.aimMethod,
    fireRatePerS: round(num(tpl.fireRatePerS)),
    spinUpS: round(num(tpl.spinUpS)),
    hoodAdjustS: round(num(tpl.hoodAdjustS)),
    alignTimeS: round(num(tpl.alignTimeS)),
    turretSlewDegPerS: round(num(tpl.turretSlewDegPerS), 0),
    shootOnMove: tpl.shootOnMove,
    sotmAccuracyBySpeed: tpl.sotmAccuracyBySpeed,
    shotAccuracyByDistance: tpl.shotAccuracyByDistance.map((row) => ({
      distanceM: row.distanceM,
      accuracy: round(Math.min(1, row.accuracy * accuracyScale), 3),
    })),
    minShotDistanceM: round(num(tpl.minShotDistanceM)),
    maxShotDistanceM: round(num(tpl.maxShotDistanceM)),
    capacity: Math.max(0, int(tpl.capacity)),
    intakeRatePerS: round(num(tpl.intakeRatePerS)),
    intakeWidth: flip(tpl.wideIntakeProbability) ? "wide" : "narrow",
    canCollectWhileShooting: flip(tpl.canCollectWhileShootingProbability),
    canIntakeOverBump: flip(tpl.canIntakeOverBumpProbability),
    speedEmptyMps: round(speedEmptyMps),
    speedFullMps: round(speedEmptyMps * num(tpl.speedFullFraction)),
    accelEmpty: round(accelEmpty),
    accelFull: round(accelEmpty * num(tpl.accelFullFraction)),
    massEmptyKg: round(num(tpl.massEmptyKg), 1),
    fuelMassKg,
    traction: round(num(tpl.traction)),
    drivetrain: flip(tpl.swerveProbability) ? "swerve" : "tank",
    pushForceN: round(num(tpl.pushForceN), 0),
    heightClass: flip(tpl.tallProbability) ? "tall" : "short",
    fitsUnderTrench: flip(tpl.fitsUnderTrenchProbability),
    passRangeM: round(num(tpl.passRangeM)),
    passRatePerS: round(num(tpl.passRatePerS)),
    climbLevel: Math.min(3, Math.max(0, int(tpl.climbLevel))),
    climbTimeS: round(num(tpl.climbTimeS)),
  });
}
