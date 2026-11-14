/**
 * Action contract: the confirmed master list of robot actions, the Intent shape, the allowed
 * two-step pairs, captain roles, and option masking.
 *
 * Every option offered to a decision model is one IntentOption: a stable `label` plus a
 * one-sentence plain-English `description`. Both are used VERBATIM in model prompts, so changing
 * a label or description here invalidates caches and answer keys.
 */
import { z } from "zod";
import { RobotIdSchema, dist } from "./common";
import {
  DIRECTIONS,
  DirectionSchema,
  LANE_IDS,
  LaneIdSchema,
  ROUTE_IDS,
  RouteIdSchema,
  ZONES,
  ZoneSchema,
  isTrench,
  zoneCenter,
  type Zone,
} from "./field";
import { climbTimeForLevel } from "./profiles";
import type { MatchState, RobotState } from "./state";

// ── parameter vocabularies ───────────────────────────────────────────────────

/** Where `collect` gathers fuel: the neutral zone, wherever the robot is now, or its own depot. */
export const CollectSourceSchema = z.enum(["neutral", "local", "depot"]);
export type CollectSource = z.infer<typeof CollectSourceSchema>;
export const COLLECT_SOURCES = CollectSourceSchema.options;

/** Tower climb level. */
export const ClimbLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type ClimbLevel = z.infer<typeof ClimbLevelSchema>;
export const CLIMB_LEVELS: readonly ClimbLevel[] = [1, 2, 3];

/** Id of a shot/staging spot (ShotSpot.id) belonging to the acting robot's alliance. */
export const SpotIdSchema = z.string().min(1);

const none = z.object({});
const step = <A extends string, P extends z.ZodType>(action: A, params: P) =>
  z.object({
    /** Action name from the master list. */
    action: z.literal(action),
    /** Parameters for the action; `{}` when it takes none. */
    params,
  });

// ── the master list (exact names; do not rename) ─────────────────────────────

/** One action with its parameters. Discriminated on `action`. */
export const IntentStepSchema = z.discriminatedUnion("action", [
  // Movement
  /** Drive to the centre of a zone. */
  step("goto_zone", z.object({ zone: ZoneSchema })),
  /** Drive to a named shot spot. */
  step("goto_shot_spot", z.object({ spotId: SpotIdSchema })),
  /** Cross between the alliance zone and the neutral zone through a specific trench or bump. */
  step("route_via", z.object({ route: RouteIdSchema })),
  /** Stay where you are. */
  step("hold_position", none),

  // Collect
  /** Gather loose fuel from the neutral zone, the current area, or the depot. */
  step("collect", z.object({ source: CollectSourceSchema })),
  /** Take fuel from the human player at the outpost. */
  step("load_outpost", none),
  /** Take loose fuel out of a zone the opponents are relying on. */
  step("steal_fuel", z.object({ zone: ZoneSchema })),

  // Score
  /** Fire immediately from the current position (assumes the robot is already aligned). */
  step("shoot_now", none),
  /** Align to the hub first, then fire. */
  step("align_then_shoot", none),
  /** Fire without aligning: fast but inaccurate. */
  step("dump_unaligned", none),
  /** Fire while driving, either along a route or toward a shot spot. Exactly one of path / spotId. */
  step("shoot_on_move", z.union([z.strictObject({ path: RouteIdSchema }), z.strictObject({ spotId: SpotIdSchema })])),
  /** Hold fuel and wait; start firing the moment our hub becomes active. */
  step("hold_fire_until_active", none),
  /** Drop held fuel in a pile at a shot spot for later. */
  step("stage_fuel", z.object({ spotId: SpotIdSchema })),
  /** Pass held fuel to a partner robot or lob it into a zone. Exactly one of robotId / zone. */
  step("pass_to", z.union([z.strictObject({ robotId: RobotIdSchema }), z.strictObject({ zone: ZoneSchema })])),

  // Defense / contact
  /** Play defense on one opposing robot. */
  step("defend", z.object({ robotId: RobotIdSchema })),
  /** Park in a trench or bump lane to block traffic. */
  step("block_lane", z.object({ laneId: LaneIdSchema })),
  /** Set a legal screen that shields a partner robot from defenders. */
  step("screen", z.object({ robotId: RobotIdSchema })),
  /** Drive hard through a blocker in the given direction. */
  step("push_through", z.object({ direction: DirectionSchema })),
  /** Break contact by spinning off the other robot, then head for a zone. */
  step("escape_spin", z.object({ exitToward: ZoneSchema })),
  /** Break contact by backing straight out, then head for a zone. */
  step("escape_reverse", z.object({ exitToward: ZoneSchema })),
  /** Stop defending or contesting and back away. */
  step("disengage", none),

  // Endgame
  /** Drive to the tower and climb to a level. */
  step("climb", z.object({ level: ClimbLevelSchema })),
  /** Shield a climbing partner from interference. */
  step("protect_climber", z.object({ robotId: RobotIdSchema })),
  /** Abandon a climb in progress. */
  step("abort_climb", none),
]);
export type IntentStep = z.infer<typeof IntentStepSchema>;
export type ActionName = IntentStep["action"];

/** All action names, grouped as in the master list. */
export const ACTION_GROUPS = {
  movement: ["goto_zone", "goto_shot_spot", "route_via", "hold_position"],
  collect: ["collect", "load_outpost", "steal_fuel"],
  score: ["shoot_now", "align_then_shoot", "dump_unaligned", "shoot_on_move", "hold_fire_until_active", "stage_fuel", "pass_to"],
  defense: ["defend", "block_lane", "screen", "push_through", "escape_spin", "escape_reverse", "disengage"],
  endgame: ["climb", "protect_climber", "abort_climb"],
} as const satisfies Record<string, readonly ActionName[]>;

/** Flat list of every action name. */
export const ACTION_NAMES: readonly ActionName[] = Object.values(ACTION_GROUPS).flat();

// ── allowed two-step pairs ───────────────────────────────────────────────────

/**
 * ALLOWED_PAIRS[first] = the actions that may follow `first` as an intent's `then` step.
 * Actions not listed here cannot have a `then`.
 */
export const ALLOWED_PAIRS: Partial<Record<ActionName, readonly ActionName[]>> = {
  escape_spin: ["defend", "stage_fuel", "collect", "goto_shot_spot"],
  escape_reverse: ["defend", "stage_fuel", "collect", "goto_shot_spot"],
  disengage: ["defend", "stage_fuel", "collect", "goto_shot_spot"],
  pass_to: ["defend", "collect", "screen"],
  collect: ["stage_fuel", "hold_fire_until_active", "goto_shot_spot"],
  shoot_on_move: ["climb", "defend", "collect"],
  shoot_now: ["climb", "defend", "collect"],
};

/** Actions allowed as the `then` step after `first` (empty when none). */
export function allowedThen(first: ActionName): readonly ActionName[] {
  return ALLOWED_PAIRS[first] ?? [];
}

/** True when `then` may follow `first` in one intent. */
export function isAllowedPair(first: ActionName, then: ActionName): boolean {
  return allowedThen(first).includes(then);
}

/**
 * Intent = one action, optionally followed by a second action from ALLOWED_PAIRS.
 * The engine runs `then` as soon as the first action reports action_done.
 */
export const IntentSchema = IntentStepSchema.and(
  z.object({
    /** Optional follow-up action; must be an allowed pair with the first action. */
    then: IntentStepSchema.optional(),
  }),
).refine((intent) => intent.then === undefined || isAllowedPair(intent.action, intent.then.action), {
  message: "`then` action is not in ALLOWED_PAIRS for this action",
  path: ["then"],
});
export type Intent = z.infer<typeof IntentSchema>;

// ── captain roles ────────────────────────────────────────────────────────────

/** Role an alliance captain assigns to one robot for a stretch of the match. */
export const CaptainRoleSchema = z.discriminatedUnion("role", [
  /** Primary fuel scorer. */
  z.object({ role: z.literal("scorer") }),
  /** Moves fuel to partners by passing. */
  z.object({ role: z.literal("feeder") }),
  /** Stages fuel at shot spots ahead of an active shift. */
  z.object({ role: z.literal("stager") }),
  /** Gathers loose fuel. */
  z.object({ role: z.literal("collector") }),
  /** Defends one named opposing robot. */
  z.object({
    role: z.literal("defender"),
    /** The opposing robot to defend. */
    target: RobotIdSchema,
  }),
  /** Heads for the tower to climb. */
  z.object({ role: z.literal("climber") }),
]);
export type CaptainRole = z.infer<typeof CaptainRoleSchema>;
export const CAPTAIN_ROLE_NAMES = ["scorer", "feeder", "stager", "collector", "defender", "climber"] as const;

// ── labels and descriptions ──────────────────────────────────────────────────

/** One option presented to a decision model. */
export const IntentOptionSchema = z.object({
  /** Stable machine label, unique within an option list (for example "goto_zone:neutral"). */
  label: z.string().min(1),
  /** One-sentence plain-English description, used verbatim in prompts. */
  description: z.string().min(1),
  /** The intent the engine executes when this option is chosen. */
  intent: IntentSchema,
});
export type IntentOption = z.infer<typeof IntentOptionSchema>;

const ZONE_WORDS: Record<Zone, string> = {
  our_alliance: "our alliance zone",
  neutral: "the neutral zone",
  their_alliance: "the opponents' alliance zone",
  outpost: "our outpost",
  depot: "our depot",
  tower: "our tower",
};
const words = (id: string) => id.replaceAll("_", " ");

/** Stable label for one step: `action` or `action:param`. */
export function stepLabel(s: IntentStep): string {
  switch (s.action) {
    case "goto_zone":
      return `goto_zone:${s.params.zone}`;
    case "goto_shot_spot":
      return `goto_shot_spot:${s.params.spotId}`;
    case "route_via":
      return `route_via:${s.params.route}`;
    case "collect":
      return `collect:${s.params.source}`;
    case "steal_fuel":
      return `steal_fuel:${s.params.zone}`;
    case "shoot_on_move":
      return "path" in s.params ? `shoot_on_move:path=${s.params.path}` : `shoot_on_move:spot=${s.params.spotId}`;
    case "stage_fuel":
      return `stage_fuel:${s.params.spotId}`;
    case "pass_to":
      return "robotId" in s.params ? `pass_to:robot=${s.params.robotId}` : `pass_to:zone=${s.params.zone}`;
    case "defend":
      return `defend:${s.params.robotId}`;
    case "block_lane":
      return `block_lane:${s.params.laneId}`;
    case "screen":
      return `screen:${s.params.robotId}`;
    case "push_through":
      return `push_through:${s.params.direction}`;
    case "escape_spin":
      return `escape_spin:${s.params.exitToward}`;
    case "escape_reverse":
      return `escape_reverse:${s.params.exitToward}`;
    case "climb":
      return `climb:${s.params.level}`;
    case "protect_climber":
      return `protect_climber:${s.params.robotId}`;
    default:
      return s.action;
  }
}

/** One plain-English sentence for one step. */
export function describeStep(s: IntentStep): string {
  switch (s.action) {
    case "goto_zone":
      return `Drive to ${ZONE_WORDS[s.params.zone]}.`;
    case "goto_shot_spot":
      return `Drive to the ${words(s.params.spotId)} shot spot.`;
    case "route_via":
      return `Cross between our alliance zone and the neutral zone through the ${words(s.params.route)}.`;
    case "hold_position":
      return "Stay in the current position.";
    case "collect":
      return s.params.source === "neutral"
        ? "Drive to the neutral zone and collect loose fuel there."
        : s.params.source === "depot"
          ? "Drive to our depot and collect the fuel there."
          : "Collect the loose fuel near the current position.";
    case "load_outpost":
      return "Drive to our outpost and load fuel from the human player.";
    case "steal_fuel":
      return `Take loose fuel from ${ZONE_WORDS[s.params.zone]} so the opponents cannot use it.`;
    case "shoot_now":
      return "Shoot the held fuel at our hub right now from this position.";
    case "align_then_shoot":
      return "Take time to align to our hub, then shoot the held fuel.";
    case "dump_unaligned":
      return "Shoot the held fuel immediately without aligning, accepting lower accuracy.";
    case "shoot_on_move":
      return "path" in s.params
        ? `Shoot at our hub while driving through the ${words(s.params.path)}.`
        : `Shoot at our hub while driving toward the ${words(s.params.spotId)} shot spot.`;
    case "hold_fire_until_active":
      return "Hold the fuel and wait, then shoot as soon as our hub becomes active.";
    case "stage_fuel":
      return `Drop the held fuel in a pile at the ${words(s.params.spotId)} shot spot for later.`;
    case "pass_to":
      return "robotId" in s.params
        ? `Pass the held fuel to partner robot ${s.params.robotId}.`
        : `Pass the held fuel into ${ZONE_WORDS[s.params.zone]}.`;
    case "defend":
      return `Play defense on opposing robot ${s.params.robotId}, staying between it and its hub.`;
    case "block_lane":
      return `Park in the ${words(s.params.laneId)} to block robots from using it.`;
    case "screen":
      return `Set a legal screen that shields partner robot ${s.params.robotId} from defenders.`;
    case "push_through":
      return `Push through the robot in the way, driving ${words(s.params.direction)}.`;
    case "escape_spin":
      return `Spin off the robot in contact and escape toward ${ZONE_WORDS[s.params.exitToward]}.`;
    case "escape_reverse":
      return `Back straight out of contact and escape toward ${ZONE_WORDS[s.params.exitToward]}.`;
    case "disengage":
      return "Stop contesting and back away from the other robot.";
    case "climb":
      return `Drive to our tower and climb to level ${s.params.level}.`;
    case "protect_climber":
      return `Shield partner robot ${s.params.robotId} from interference while it climbs.`;
    case "abort_climb":
      return "Abandon the climb in progress and come back down.";
  }
}

/** Stable label for a whole intent: `first` or `first>then`. */
export function intentLabel(intent: Intent): string {
  return intent.then ? `${stepLabel(intent)}>${stepLabel(intent.then)}` : stepLabel(intent);
}

/** One plain-English sentence for a whole intent. */
export function describeIntent(intent: Intent): string {
  if (!intent.then) return describeStep(intent);
  const second = describeStep(intent.then);
  return `${describeStep(intent).slice(0, -1)}, and after that: ${second.charAt(0).toLowerCase()}${second.slice(1)}`;
}

/** Build the option (label + description) for an intent. */
export function toOption(intent: Intent): IntentOption {
  return { label: intentLabel(intent), description: describeIntent(intent), intent };
}

/**
 * Combine a first option with a follow-up option into one two-step option.
 * Returns undefined when the pair is not in ALLOWED_PAIRS.
 */
export function withThen(first: IntentOption, then: IntentOption): IntentOption | undefined {
  if (first.intent.then || then.intent.then) return undefined;
  if (!isAllowedPair(first.intent.action, then.intent.action)) return undefined;
  const { action, params } = then.intent;
  return toOption({ ...first.intent, then: { action, params } as IntentStep } as Intent);
}

// ── option masking ───────────────────────────────────────────────────────────

const CONTESTING_ACTIONS: readonly ActionName[] = ["defend", "block_lane", "screen", "push_through", "protect_climber"];

/**
 * maskOptions(robot, state) -> the single-step options this robot may legally choose right now.
 *
 * Rules from the planner's list:
 *   1. no fuel                          -> no shoot, pass or stage
 *   2. not shootOnMove                  -> no shoot_on_move
 *   3. !fitsUnderTrench                 -> no trench routes (route_via and shoot_on_move paths)
 *   4. hub outside the robot's shot range (for a dumper: not adjacent to the hub)
 *                                       -> no shoot_now / align_then_shoot (goto_shot_spot is offered)
 *   5. no partner within passRangeM     -> no pass_to
 *   6. not enough time for a climb level-> no climb at that level
 *   7. already aligned                  -> shoot_now instead of align_then_shoot (and vice versa)
 *
 * Extra masks for options that are physically impossible (not on the planner's list):
 *   - hopper full                       -> no collect / load_outpost / steal_fuel
 *   - shooterType none                  -> no shooting actions at all
 *   - not in contact                    -> no escape_spin / escape_reverse / push_through
 *   - not in contact and not contesting -> no disengage
 *   - not climbing                      -> no abort_climb
 *   - climb in progress                 -> only "keep climbing" (the same climb level) and abort_climb
 *   - hanging on the tower              -> only hold_position
 *   - no partner climbing               -> no protect_climber
 *
 * Two-step options are not enumerated here (the list would explode). Build them with
 * allowedThen() / withThen() from two single-step choices.
 *
 * Output order is deterministic: master-list order, then parameter order.
 */
export function maskOptions(robot: RobotState, state: MatchState): IntentOption[] {
  const p = robot.profile;
  const field = state.field;
  const steps: IntentStep[] = [];

  if (robot.climb.inProgress) {
    // Mid-climb: keep going (re-choosing the same climb continues it) or abort.
    steps.push({ action: "climb", params: { level: robot.climb.targetLevel as ClimbLevel } });
    steps.push({ action: "abort_climb", params: {} });
    return steps.map((s) => toOption(s));
  }
  if (robot.climb.level > 0) {
    // Hanging on the tower: nothing to do but stay.
    return [toOption({ action: "hold_position", params: {} })];
  }

  const hasFuel = robot.fuelHeld > 0;
  const hasRoom = robot.fuelHeld < p.capacity;
  const canShoot = p.shooterType !== "none" && p.fireRatePerS > 0;
  const hubDistM = dist(robot.pose, field.alliances[robot.alliance].hub);
  const inShotRange = hubDistM >= p.minShotDistanceM && hubDistM <= p.maxShotDistanceM;
  const inContact = robot.contact.withRobotId !== null;
  const contesting = robot.intent !== null && CONTESTING_ACTIONS.includes(robot.intent.action);
  const spots = field.shotSpots.filter((s) => s.alliance === robot.alliance);
  const partners = state.robots.filter((r) => r.alliance === robot.alliance && r.id !== robot.id);
  const opponents = state.robots.filter((r) => r.alliance !== robot.alliance);
  const partnersInPassRange = partners.filter((r) => dist(robot.pose, r.pose) <= p.passRangeM);
  const routes = ROUTE_IDS.filter((r) => p.fitsUnderTrench || !isTrench(r));

  // Movement
  for (const zone of ZONES) steps.push({ action: "goto_zone", params: { zone } });
  for (const s of spots) steps.push({ action: "goto_shot_spot", params: { spotId: s.id } });
  for (const route of routes) steps.push({ action: "route_via", params: { route } });
  steps.push({ action: "hold_position", params: {} });

  // Collect
  if (hasRoom) {
    for (const source of COLLECT_SOURCES) steps.push({ action: "collect", params: { source } });
    steps.push({ action: "load_outpost", params: {} });
    steps.push({ action: "steal_fuel", params: { zone: "their_alliance" } });
    steps.push({ action: "steal_fuel", params: { zone: "neutral" } });
  }

  // Score
  if (hasFuel) {
    if (canShoot) {
      if (inShotRange) {
        steps.push(robot.alignment.aligned ? { action: "shoot_now", params: {} } : { action: "align_then_shoot", params: {} });
      }
      steps.push({ action: "dump_unaligned", params: {} });
      if (p.shootOnMove) {
        for (const path of routes) steps.push({ action: "shoot_on_move", params: { path } });
        for (const s of spots) steps.push({ action: "shoot_on_move", params: { spotId: s.id } });
      }
      steps.push({ action: "hold_fire_until_active", params: {} });
    }
    for (const s of spots) steps.push({ action: "stage_fuel", params: { spotId: s.id } });
    if (partnersInPassRange.length > 0) {
      for (const r of partnersInPassRange) steps.push({ action: "pass_to", params: { robotId: r.id } });
      for (const zone of ["our_alliance", "neutral"] as const) {
        if (dist(robot.pose, zoneCenter(field, robot.alliance, zone)) <= p.passRangeM) {
          steps.push({ action: "pass_to", params: { zone } });
        }
      }
    }
  }

  // Defense / contact
  for (const r of opponents) steps.push({ action: "defend", params: { robotId: r.id } });
  for (const laneId of LANE_IDS) {
    if (p.fitsUnderTrench || !laneId.endsWith("_trench")) steps.push({ action: "block_lane", params: { laneId } });
  }
  for (const r of partners) steps.push({ action: "screen", params: { robotId: r.id } });
  if (inContact) {
    for (const direction of DIRECTIONS) steps.push({ action: "push_through", params: { direction } });
    for (const exitToward of ["our_alliance", "neutral", "their_alliance"] as const) {
      steps.push({ action: "escape_spin", params: { exitToward } });
    }
    for (const exitToward of ["our_alliance", "neutral", "their_alliance"] as const) {
      steps.push({ action: "escape_reverse", params: { exitToward } });
    }
  }
  if (inContact || contesting) steps.push({ action: "disengage", params: {} });

  // Endgame
  const inAuto = state.phase === "auto";
  const timeLeftS = inAuto ? state.rules.autoS - state.timeS : state.rules.matchS - state.timeS;
  const travelS = dist(robot.pose, field.alliances[robot.alliance].tower) / p.speedEmptyMps;
  for (const level of CLIMB_LEVELS) {
    if (level > p.climbLevel) continue;
    if (inAuto && level > 1) continue;
    if (travelS + climbTimeForLevel(p, level) + state.rules.triggers.climbSafetyMarginS <= timeLeftS) {
      steps.push({ action: "climb", params: { level } });
    }
  }
  for (const r of partners) {
    if (r.climb.inProgress || r.intent?.action === "climb") steps.push({ action: "protect_climber", params: { robotId: r.id } });
  }

  return steps.map((s) => toOption(s));
}

/**
 * The follow-up options allowed after `first`, taken from an already-masked option list.
 * Use with withThen() to build a two-step option.
 */
export function maskThenOptions(first: IntentOption, options: readonly IntentOption[]): IntentOption[] {
  const allowed = allowedThen(first.intent.action);
  return options.filter((o) => !o.intent.then && allowed.includes(o.intent.action));
}
