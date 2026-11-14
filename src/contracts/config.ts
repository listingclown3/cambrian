/**
 * Config contract: the shape of config/default.json. Every tunable and every assumed number
 * lives in that file, never in code.
 *
 * Provenance:
 *   - `game` and `field` values are wrapped as { value, status, source } where status is
 *     VERIFIED or TODO_VERIFY_AGAINST_MANUAL. Read them as `cfg.game.autoS.value`.
 *   - every other section carries `_status` (FABRICATED or TUNABLE) and a `_note`.
 *
 * NEVER take game numbers from Chief Delphi parody documents. Only the official manual counts.
 */
import { z } from "zod";
import { AllianceSchema, Vec2Schema } from "./common";
import { ProviderIdSchema } from "./decide";
import { RouteIdSchema } from "./field";
import { ArchetypeSchema, ArchetypeTemplateSchema } from "./profiles";

/** Provenance of a game or field constant. */
export const ProvenanceStatusSchema = z.enum(["VERIFIED", "TODO_VERIFY_AGAINST_MANUAL"]);
export type ProvenanceStatus = z.infer<typeof ProvenanceStatusSchema>;

/** A constant together with where it came from. */
const annotated = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    /** The number (or value) itself. */
    value,
    /** VERIFIED against an official source, or still to be checked against the manual. */
    status: ProvenanceStatusSchema,
    /** Where the value came from. */
    source: z.string().min(1),
  });

/** Marker fields carried by every non-game section. */
const sectionMeta = {
  /** FABRICATED = invented plausible numbers; TUNABLE = engineering knobs we chose. */
  _status: z.enum(["FABRICATED", "TUNABLE"]),
  /** What this section is and how much to trust it. */
  _note: z.string(),
};

export const GameConfigSchema = z.strictObject({
  /** Autonomous period length, seconds. */
  autoS: annotated(z.number().positive()),
  /** Teleop length, seconds. */
  teleopS: annotated(z.number().positive()),
  /** Points per fuel scored in an active hub. */
  fuelPointsActiveHub: annotated(z.number()),
  /** Points per fuel scored in an inactive hub. */
  fuelPointsInactiveHub: annotated(z.number()),
  /** Tower points in teleop for levels 1, 2, 3. */
  towerTeleopPoints: annotated(z.tuple([z.number(), z.number(), z.number()])),
  /** Tower points for a level 1 climb in auto. */
  towerAutoL1Points: annotated(z.number()),
  /** Points given to the opponents for a minor foul. */
  minorFoulPoints: annotated(z.number()),
  /** Points given to the opponents for a major foul. */
  majorFoulPoints: annotated(z.number()),
  /** Maximum fuel a robot may be preloaded with. */
  maxPreloadFuel: annotated(z.number().int().nonnegative()),
  /** Length of the warning before a hub deactivates, seconds. */
  hubDeactivationWarningS: annotated(z.number().nonnegative()),
  /** True if every hub is active during the final period. */
  allHubsActiveAtEnd: annotated(z.boolean()),
  /** Mass of one fuel ball, kilograms. */
  fuelMassKg: annotated(z.number().positive()),
  /** Hub shift schedule inside teleop. */
  hubShiftSchedule: annotated(
    z.strictObject({
      /** Seconds at the start of teleop when both hubs are active. */
      transitionS: z.number().nonnegative(),
      /** Length of each alternating shift, seconds. */
      shiftS: z.number().positive(),
      /** Number of alternating shifts. */
      numShifts: z.number().int().nonnegative(),
      /** True if the alliance that scored more in auto has its hub inactive in shift 1. */
      autoWinnerInactiveFirst: z.boolean(),
    }),
  ),
  /** Endgame length, seconds (counted inside teleop). */
  endgameS: annotated(z.number().nonnegative()),
  /** Pinning limits. */
  pinning: annotated(
    z.strictObject({
      /** Seconds a robot may pin an opponent before a foul. */
      limitS: z.number().positive(),
      /** Distance the pinning robot must back off to end a pin, metres. */
      releaseDistanceM: z.number().positive(),
      /** Severity of the pinning foul. */
      severity: z.enum(["minor", "major"]),
      /** Rule clause id recorded on the foul. */
      clauseId: z.string(),
    }),
  ),
  /** How much fuel starts where. */
  fuelStart: annotated(
    z.strictObject({
      /** Loose fuel in the neutral zone at the start. */
      neutral: z.number().int().nonnegative(),
      /** Fuel in each alliance's depot at the start. */
      depotEach: z.number().int().nonnegative(),
      /** Fuel available at each alliance's outpost at the start. */
      outpostEach: z.number().int().nonnegative(),
    }),
  ),
});
export type GameConfig = z.infer<typeof GameConfigSchema>;

export const FieldConfigSchema = z.strictObject({
  /** Field length (alliance wall to alliance wall), metres. */
  lengthM: annotated(z.number().positive()),
  /** Field width, metres. */
  widthM: annotated(z.number().positive()),
  /** Depth of each alliance zone measured from its alliance wall, metres. */
  allianceZoneDepthM: annotated(z.number().positive()),
  /**
   * Blue-side element positions in field coordinates (blue wall at x = 0).
   * Red's elements are the 180-degree rotation of these about the field centre.
   */
  blueElements: annotated(
    z.strictObject({
      /** Hub centre. */
      hub: Vec2Schema,
      /** Tower position. */
      tower: Vec2Schema,
      /** Depot position. */
      depot: Vec2Schema,
      /** Outpost position. */
      outpost: Vec2Schema,
    }),
  ),
  /** y coordinate of each trench/bump crossing on the blue side, metres. */
  blueLaneY: annotated(z.record(RouteIdSchema, z.number())),
  /** Length of a trench/bump crossing along x, metres. */
  laneLengthM: annotated(z.number().positive()),
  /** Marker fields for the fabricated shot spots below. */
  shotSpots: z.strictObject({
    ...sectionMeta,
    /** Shot/staging spots relative to an alliance's own hub. */
    spots: z.array(
      z.strictObject({
        /** Spot id, used in labels. */
        id: z.string().min(1),
        /** Metres from the hub toward the neutral zone (negative = toward the alliance wall). */
        forwardFromHubM: z.number(),
        /** Metres from the hub toward the driver's left. */
        leftFromHubM: z.number(),
        /** Short description. */
        description: z.string(),
      }),
    ),
  }),
});
export type FieldConfig = z.infer<typeof FieldConfigSchema>;

/** Connection settings for one decision provider. Secrets come from env vars, never from this file. */
export const ProviderConfigSchema = z.strictObject({
  /** Full URL requests are sent to; null for providers that never touch the network. */
  endpoint: z.string().nullable(),
  /** Model id to request; null when not applicable. Values starting with TODO_ must be filled in by a human. */
  model: z.string().nullable(),
  /** Name of the HTTP header that carries the API key. */
  authHeader: z.string().nullable(),
  /** Prefix put before the key in the auth header (for example "Bearer"), or null for the bare key. */
  authScheme: z.string().nullable(),
  /** Name of the environment variable holding the API key. */
  apiKeyEnv: z.string().nullable(),
  /** Extra fixed headers to send with every request. */
  extraHeaders: z.record(z.string(), z.string()),
  /** Maximum requests in flight at once. */
  concurrency: z.number().int().positive(),
  /** Per-request timeout, milliseconds. */
  timeoutMs: z.number().int().positive(),
  /** Retries after the first attempt (offline mode only). */
  retries: z.number().int().nonnegative(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Price of one provider, US dollars per million tokens. null = not filled in yet. */
export const PriceSchema = z.strictObject({
  /** Dollars per 1M input tokens. */
  input: z.number().nonnegative().nullable(),
  /** Dollars per 1M output tokens. */
  output: z.number().nonnegative().nullable(),
});

/** Physics knobs. Copied into MatchState.rules so the engine can run from a snapshot alone. */
export const PhysicsParamsSchema = z.object({
  /** Simulation tick, seconds. */
  dtS: z.number().positive(),
  /** Robot footprint radius used for contact, metres. */
  robotRadiusM: z.number().positive(),
  /** Distance at which a robot counts as arrived at a target, metres. */
  arriveToleranceM: z.number().positive(),
  /** Speed multiplier while crossing a bump. */
  bumpSpeedFactor: z.number().positive(),
  /** Speed multiplier while crossing a trench. */
  trenchSpeedFactor: z.number().positive(),
  /** Fraction of relative speed kept after a robot-robot collision. */
  restitution: z.number().min(0).max(1),
  /** Peak drivetrain rotation rate, degrees per second. */
  maxTurnRateDegPerS: z.number().positive(),
});
export type PhysicsParams = z.infer<typeof PhysicsParamsSchema>;

/** Shot model knobs. Copied into MatchState.rules. */
export const ShotModelParamsSchema = z.object({
  /** Fuel flight speed, metres per second. */
  ballSpeedMps: z.number().positive(),
  /** Accuracy multiplier for dump_unaligned. */
  dumpUnalignedAccuracyFactor: z.number().min(0).max(1),
  /** Accuracy multiplier while a defender is in contact with a short shooter. */
  defendedAccuracyFactorShort: z.number().min(0).max(1),
  /** Accuracy multiplier while a defender is in contact with a tall shooter. */
  defendedAccuracyFactorTall: z.number().min(0).max(1),
  /** Fraction of scored fuel the hub returns to the neutral zone (the rest goes to the alliance zone). */
  hubReturnToNeutralFraction: z.number().min(0).max(1),
});
export type ShotModelParams = z.infer<typeof ShotModelParamsSchema>;

/** Thresholds that turn engine conditions into decision triggers. Copied into MatchState.rules. */
export const TriggerParamsSchema = z.object({
  /** Seconds of continuous contact before contact_long fires. */
  contactLongS: z.number().positive(),
  /** Seconds without getting closer to the target before no_progress fires. */
  noProgressS: z.number().positive(),
  /** Movement below this many metres over noProgressS counts as no progress. */
  noProgressMinMoveM: z.number().positive(),
  /** Seconds since a robot's last decision before watchdog fires (and fires again every such interval). */
  watchdogS: z.number().positive(),
  /** Distance at which opponent_in_range fires, metres. */
  opponentInRangeM: z.number().positive(),
  /** Seconds after which a running action reports action_timeout. */
  actionTimeoutS: z.number().positive(),
  /** Spare seconds required on top of travel + climb time before a climb is offered. */
  climbSafetyMarginS: z.number().nonnegative(),
});
export type TriggerParams = z.infer<typeof TriggerParamsSchema>;

export const ConfigSchema = z.strictObject({
  /** Free-text explanation at the top of the file. */
  _readme: z.string(),
  /** Official game constants, each with provenance. */
  game: GameConfigSchema,
  /** Field geometry, each with provenance. */
  field: FieldConfigSchema,
  /** Archetype templates the league is sampled from. */
  archetypes: z.strictObject({
    ...sectionMeta,
    /** One template per archetype. */
    templates: z.record(ArchetypeSchema, ArchetypeTemplateSchema),
  }),
  /** League sampling. */
  league: z.strictObject({
    ...sectionMeta,
    /** Number of teams to sample into data/league/. */
    teams: z.number().int().positive(),
    /** Relative frequency of each archetype in the league. */
    archetypeWeights: z.record(ArchetypeSchema, z.number().nonnegative()),
    /** Seed for league sampling. */
    seed: z.number().int(),
  }),
  /** Physics knobs. */
  physics: z.strictObject({ ...sectionMeta, ...PhysicsParamsSchema.shape }),
  /** Shot model knobs. */
  shotModel: z.strictObject({ ...sectionMeta, ...ShotModelParamsSchema.shape }),
  /** Thresholds that turn engine conditions into decision triggers. */
  triggers: z.strictObject({ ...sectionMeta, ...TriggerParamsSchema.shape }),
  /** Short look-ahead rollouts used inside a live decision. */
  microRollouts: z.strictObject({
    ...sectionMeta,
    /** Rollouts per candidate option. */
    count: z.number().int().positive(),
    /** Rollout horizon, seconds. */
    horizonS: z.number().positive(),
  }),
  /** Long rollouts that define the answer key for scenarios. */
  answerKey: z.strictObject({
    ...sectionMeta,
    /** Rollouts per option. */
    rollouts: z.number().int().positive(),
    /** Rollout horizon, seconds. */
    horizonS: z.number().positive(),
  }),
  /** Per-provider connection settings. */
  providers: z.strictObject({
    ...sectionMeta,
    /** Settings keyed by provider id. */
    byId: z.record(ProviderIdSchema, ProviderConfigSchema),
  }),
  /** Prices per 1M tokens; humans fill these in from each provider's pricing page. */
  pricesPerMTokUsd: z.strictObject({
    ...sectionMeta,
    /** Prices keyed by provider id. */
    byId: z.record(ProviderIdSchema, PriceSchema),
  }),
  /** Hard spend limits; a run aborts rather than exceed them. */
  spendCapsUsd: z.strictObject({
    ...sectionMeta,
    /** Cap per provider for one run. */
    perProviderPerRun: z.record(ProviderIdSchema, z.number().nonnegative()),
    /** Cap across all providers for one run. */
    totalPerRun: z.number().nonnegative(),
  }),
  /** Whether a provider's thinking time is charged against the match clock in live matches. */
  realtimeLatencyCharging: z.strictObject({
    ...sectionMeta,
    /** On = the match keeps running while a provider thinks; off = the match pauses. */
    enabled: z.boolean(),
    /** Multiplier applied to measured latency before charging it (1 = real time). */
    latencyScale: z.number().positive(),
  }),
  /** Seed sets. Dev seeds are for tuning; eval seeds are only for reported numbers. Keep them apart. */
  seeds: z.strictObject({
    ...sectionMeta,
    /** Seeds used while developing and tuning. */
    dev: z.array(z.number().int()),
    /** Seeds used only for final, reported results. */
    eval: z.array(z.number().int()),
  }),
  /** Local server settings. */
  server: z.strictObject({
    ...sectionMeta,
    /** Port the Node server listens on. */
    port: z.number().int().positive(),
    /** Port the Vite dev server listens on. */
    webDevPort: z.number().int().positive(),
    /** Which alliance the demo match's Drex-driven robots are on. */
    demoDrexAlliance: AllianceSchema,
  }),
});
export type Config = z.infer<typeof ConfigSchema>;
