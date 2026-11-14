/**
 * The REBUILT engine (owner: P1). Evolved from the stub (stubEngine.ts), keeping its contract
 * behaviour, with:
 *   - grid navigation around hubs, towers and the crossing bands (see nav.ts, adapted from
 *     Team 488's simulator), with bumps slowing robots and trenches closed to tall robots
 *   - load-dependent top speed and acceleration, sliding collisions with field elements,
 *     robot-robot separation and contact timers
 *   - fuel counted per zone; shots resolve instantly (no balls in flight)
 *   - hub shifts with the deactivation warning; fuel scores only in an active hub
 *   - no_progress and path_blocked events
 *
 * Deterministic and snapshot/restore exact: all state is in MatchState, all randomness comes from
 * MatchState.rngState, robots are processed in state order.
 */
import {
  ALLIANCES,
  PhysicsParamsSchema,
  STATE_SCHEMA_VERSION,
  ShotModelParamsSchema,
  TriggerParamsSchema,
  climbTimeForLevel,
  directionVector,
  dist,
  fieldZoneOf,
  findLane,
  floorZoneAt,
  isTrench,
  loadedMassKg,
  otherAlliance,
  zoneCenter,
  type Alliance,
  type Config,
  type Engine,
  type EngineEvent,
  type FieldZoneId,
  type Intent,
  type IntentStep,
  type MatchRobotSpec,
  type MatchState,
  type RobotId,
  type RobotState,
  type RolloutOptions,
  type RolloutPolicies,
  type RolloutResult,
  type RouteId,
  type Snapshot,
  type StepResult,
  type Vec2,
} from "../contracts";
import { Rng, seedState } from "../util/rng";
import { buildFieldLayout } from "./field";
import { isTriggerFor } from "../exec/triggers";
import { buildObservationView, eventConcerns } from "./observe";
import { getGrid, resolvePosition, snapTarget, steer, terrainFactor } from "./nav";

const EPS = 1e-9;
/** Standard gravity, used only when physics.gravityMps2 is absent (config/default.json sets it). */
const DEFAULT_GRAVITY = 9.81;
/** A point target counts as reached once the robot centre is this close, metres (well below any tolerance). */
const ARRIVE_EXACT_M = 1e-3;

/**
 * Rule G420 "TOWER protection", 2026 manual p.73 (data/rules/conduct_rules.json): "A ROBOT may
 * not contact, directly or transitively through a SCORING ELEMENT, an opponent ROBOT in contact
 * with an opponent TOWER during the last 30 seconds of the MATCH regardless of who initiates
 * contact. Violation: MAJOR FOUL and if the opponent ROBOT is off the ground the opponent ROBOT is
 * awarded LEVEL 3 TOWER points." Not yet in config/default.json, hence a named constant; it is
 * copied into MatchState.rules.towerProtection at createMatch.
 */
const TOWER_PROTECTION = { clauseId: "G420", lastS: 30, severity: "major", offGroundAwardLevel: 3 } as const;

/** Steps during which the shooter stays spun up. */
const SHOOTING: ReadonlySet<string> = new Set(["shoot_now", "align_then_shoot", "dump_unaligned", "shoot_on_move", "hold_fire_until_active"]);

/** Actions that run until replaced; they never report action_done or action_timeout. */
const CONTINUOUS: ReadonlySet<string> = new Set(["hold_position", "defend", "block_lane", "screen", "protect_climber", "hold_fire_until_active"]);

// ── createMatch ──────────────────────────────────────────────────────────────

function createMatch(cfg: Config, seed: number, specs: MatchRobotSpec[]): MatchState {
  const field = buildFieldLayout(cfg);
  const g = cfg.game;
  const schedule = g.hubShiftSchedule.value;
  const start = g.fuelStart.value;
  const counts: Record<Alliance, number> = { red: 0, blue: 0 };
  const totals: Record<Alliance, number> = {
    red: specs.filter((s) => s.alliance === "red").length,
    blue: specs.filter((s) => s.alliance === "blue").length,
  };

  const physics = PhysicsParamsSchema.parse(cfg.physics);
  const grid = getGrid(field, physics);
  const robots: RobotState[] = specs.map((spec) => {
    const index = ++counts[spec.alliance];
    const blueSide = spec.alliance === "blue";
    const y = (field.widthM * index) / (totals[spec.alliance] + 1);
    // Starting line: one arrive tolerance in front of the robot's own wall, moved clear of elements.
    const startX = physics.robotRadiusM + physics.arriveToleranceM + physics.robotRadiusM;
    const spawn = snapTarget(grid, { x: blueSide ? startX : field.lengthM - startX, y: blueSide ? y : field.widthM - y }, spec.profile.fitsUnderTrench);
    return {
      id: `${blueSide ? "B" : "R"}${index}`,
      alliance: spec.alliance,
      controllerId: spec.controllerId,
      profile: spec.profile,
      pose: { x: spawn.x, y: spawn.y, headingRad: blueSide ? 0 : Math.PI },
      velocity: { vx: 0, vy: 0, omega: 0 },
      fuelHeld: Math.min(g.maxPreloadFuel.value, spec.profile.capacity),
      intent: null,
      intentStage: "primary",
      intentStartedS: 0,
      lastDecisionS: 0,
      contact: { withRobotId: null, contactS: 0, pinnedByRobotId: null, pinS: 0 },
      alignment: { aligned: spec.profile.aimMethod === "turret", remainingS: spec.profile.aimMethod === "turret" ? 0 : spec.profile.alignTimeS },
      spinUp: { ready: false, remainingS: spec.profile.spinUpS },
      climb: { level: 0, inProgress: false, targetLevel: 0, remainingS: 0 },
      navTarget: null,
      noProgressS: 0,
      accum: { intake: 0, shot: 0, pass: 0 },
    };
  });

  const emptyScore = () => ({ autoFuel: 0, teleopFuel: 0, autoTower: 0, teleopTower: 0, foulPoints: 0, fuelInInactiveHub: 0, total: 0 });
  const autoS = g.autoS.value;
  const teleopS = g.teleopS.value;

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    seed,
    rngState: seedState(seed),
    tick: 0,
    timeS: 0,
    phase: "auto",
    shiftIndex: 0,
    firstInactiveAlliance: null,
    hubs: {
      red: { active: true, timeToShiftS: autoS + schedule.transitionS, warning: false },
      blue: { active: true, timeToShiftS: autoS + schedule.transitionS, warning: false },
    },
    robots,
    fuel: {
      byZone: {
        blue_alliance: 0,
        neutral: start.neutral,
        red_alliance: 0,
        blue_depot: start.depotEach,
        red_depot: start.depotEach,
        blue_outpost: start.outpostEach,
        red_outpost: start.outpostEach,
      },
      balls: [],
      piles: [],
    },
    score: { red: emptyScore(), blue: emptyScore() },
    fouls: [],
    field,
    rules: {
      autoS,
      teleopS,
      transitionS: schedule.transitionS,
      shiftS: schedule.shiftS,
      numShifts: schedule.numShifts,
      endgameS: g.endgameS.value,
      matchS: autoS + teleopS,
      hubWarningS: g.hubDeactivationWarningS.value,
      autoWinnerInactiveFirst: schedule.autoWinnerInactiveFirst,
      points: {
        fuelActive: g.fuelPointsActiveHub.value,
        fuelInactive: g.fuelPointsInactiveHub.value,
        towerTeleop: g.towerTeleopPoints.value,
        towerAutoL1: g.towerAutoL1Points.value,
        minorFoul: g.minorFoulPoints.value,
        majorFoul: g.majorFoulPoints.value,
      },
      pinning: { ...g.pinning.value },
      towerProtection: { ...TOWER_PROTECTION },
      physics,
      shotModel: ShotModelParamsSchema.parse(cfg.shotModel),
      triggers: TriggerParamsSchema.parse(cfg.triggers),
    },
  };
}

// ── clock and hubs ───────────────────────────────────────────────────────────

/** Phase and shift index at match time t. */
function phaseAt(state: MatchState, t: number): { phase: MatchState["phase"]; shiftIndex: number } {
  const r = state.rules;
  if (t >= r.matchS - EPS) return { phase: "finished", shiftIndex: 0 };
  if (t < r.autoS - EPS) return { phase: "auto", shiftIndex: 0 };
  const endgameStart = r.matchS - r.endgameS;
  if (t >= endgameStart - EPS) return { phase: "endgame", shiftIndex: 0 };
  const shiftsStart = r.autoS + r.transitionS;
  if (t < shiftsStart - EPS || r.numShifts === 0) return { phase: "transition", shiftIndex: 0 };
  return { phase: "shift", shiftIndex: Math.min(r.numShifts, Math.floor((t - shiftsStart + EPS) / r.shiftS) + 1) };
}

/** Whether an alliance's hub is active at match time t. */
function hubActiveAt(state: MatchState, alliance: Alliance, t: number): boolean {
  const { phase, shiftIndex } = phaseAt(state, t);
  if (phase !== "shift" || state.firstInactiveAlliance === null) return true;
  const firstIsInactive = shiftIndex % 2 === 1;
  return (alliance === state.firstInactiveAlliance) !== firstIsInactive;
}

/** Times at which hub states can change. */
function boundaries(state: MatchState): number[] {
  const r = state.rules;
  const out = [r.autoS, r.autoS + r.transitionS];
  for (let i = 1; i <= r.numShifts; i++) out.push(r.autoS + r.transitionS + i * r.shiftS);
  out.push(r.matchS - r.endgameS, r.matchS);
  return out;
}

function advanceClock(state: MatchState, dtS: number, rng: Rng, events: EngineEvent[]): void {
  const prevPhase = state.phase;
  const prevActive = { red: state.hubs.red.active, blue: state.hubs.blue.active };
  state.timeS = Math.round((state.timeS + dtS) * 1e6) / 1e6;
  const t = state.timeS;

  if (prevPhase === "auto" && t >= state.rules.autoS - EPS && state.firstInactiveAlliance === null) {
    const red = state.score.red.autoFuel + state.score.red.autoTower;
    const blue = state.score.blue.autoFuel + state.score.blue.autoTower;
    const winner: Alliance = red === blue ? (rng.next() < 0.5 ? "red" : "blue") : red > blue ? "red" : "blue";
    state.firstInactiveAlliance = state.rules.autoWinnerInactiveFirst ? winner : otherAlliance(winner);
  }

  const now = phaseAt(state, t);
  state.phase = now.phase;
  state.shiftIndex = now.shiftIndex;

  const bounds = boundaries(state);
  for (const alliance of ALLIANCES) {
    const hub = state.hubs[alliance];
    hub.active = hubActiveAt(state, alliance, t);
    let next: number | undefined;
    for (const b of bounds) {
      if (b > t + EPS && hubActiveAt(state, alliance, b) !== hub.active) {
        next = b;
        break;
      }
    }
    hub.timeToShiftS = Math.max(0, (next ?? state.rules.matchS) - t);
    const warning = hub.active && next !== undefined && hub.timeToShiftS <= state.rules.hubWarningS;
    if (warning && !hub.warning) events.push({ kind: "hub_warning", timeS: t, alliance, secondsToDeactivate: hub.timeToShiftS });
    hub.warning = warning;
  }

  if (prevActive.red !== state.hubs.red.active || prevActive.blue !== state.hubs.blue.active) {
    events.push({ kind: "hub_shift", timeS: t, activeAlliances: ALLIANCES.filter((a) => state.hubs[a].active) });
  }
  if (prevPhase !== "endgame" && state.phase === "endgame") events.push({ kind: "endgame_start", timeS: t });
}

// ── robot behaviour ──────────────────────────────────────────────────────────

function currentStep(robot: RobotState): IntentStep | null {
  if (robot.intent === null) return null;
  return robot.intentStage === "then" && robot.intent.then ? robot.intent.then : robot.intent;
}

function finish(state: MatchState, robot: RobotState, events: EngineEvent[], failedReason?: string): void {
  const step = currentStep(robot);
  if (!step || !robot.intent) return;
  robot.navTarget = null;
  robot.noProgressS = 0;
  if (failedReason !== undefined) {
    events.push({ kind: "action_failed", timeS: state.timeS, robotId: robot.id, action: step.action, reason: failedReason });
    robot.intent = null;
    robot.intentStage = "primary";
    return;
  }
  const continuesWithThen = robot.intentStage === "primary" && robot.intent.then !== undefined;
  events.push({ kind: "action_done", timeS: state.timeS, robotId: robot.id, action: step.action, continuesWithThen });
  if (continuesWithThen) {
    robot.intentStage = "then";
    robot.intentStartedS = state.timeS;
  } else {
    robot.intent = null;
    robot.intentStage = "primary";
  }
}

/** Far end of a crossing, as seen from where the robot is now. */
function crossingTarget(state: MatchState, robot: RobotState, route: RouteId): Vec2 | null {
  const lane = state.field.lanes.find((l) => l.side === robot.alliance && l.route === route);
  if (!lane) return null;
  return floorZoneAt(state.field, robot.pose) === `${robot.alliance}_alliance` ? lane.neutralEnd : lane.allianceEnd;
}

function offsetToward(from: Vec2, toward: Vec2, metres: number): Vec2 {
  const d = dist(from, toward);
  if (d < EPS) return { x: from.x, y: from.y };
  return { x: from.x + ((toward.x - from.x) / d) * metres, y: from.y + ((toward.y - from.y) / d) * metres };
}

/**
 * Where a robot sweeps a floor zone for loose fuel: across the zone's middle at the robot's own
 * lateral position, so robots spread out instead of all converging on one point.
 */
function sweepTarget(state: MatchState, robot: RobotState, zone: "neutral" | "our_alliance" | "their_alliance"): Vec2 {
  const field = state.field;
  const rect = zone === "neutral" ? field.neutral : field.alliances[zone === "our_alliance" ? robot.alliance : otherAlliance(robot.alliance)].zone;
  const c = zoneCenter(field, robot.alliance, zone);
  const r = state.rules.physics.robotRadiusM;
  return { x: c.x, y: Math.min(rect.y1 - r, Math.max(rect.y0 + r, robot.pose.y)) };
}

/** Where this step wants the robot to be. `undefined` = the step does not move the robot; `null` = bad target. */
function spotPos(state: MatchState, robot: RobotState, id: string): Vec2 | null {
  for (const s of state.field.shotSpots) if (s.alliance === robot.alliance && s.id === id) return s.pos;
  return null;
}

function robotById(state: MatchState, id: RobotId): RobotState | null {
  for (const r of state.robots) if (r.id === id) return r;
  return null;
}

function robotPosById(state: MatchState, id: RobotId): Vec2 | null {
  const other = robotById(state, id);
  return other ? { x: other.pose.x, y: other.pose.y } : null;
}

function resolveTarget(state: MatchState, robot: RobotState, step: IntentStep): Vec2 | null | undefined {
  const field = state.field;
  switch (step.action) {
    case "goto_zone":
      return zoneCenter(field, robot.alliance, step.params.zone);
    case "goto_shot_spot":
    case "stage_fuel":
      return spotPos(state, robot, step.params.spotId);
    case "route_via":
      return crossingTarget(state, robot, step.params.route);
    case "collect":
      if (step.params.source === "local") return undefined;
      return step.params.source === "depot" ? field.alliances[robot.alliance].depot : sweepTarget(state, robot, "neutral");
    case "load_outpost":
      return field.alliances[robot.alliance].outpost;
    case "steal_fuel":
      return step.params.zone === "neutral" || step.params.zone === "their_alliance" || step.params.zone === "our_alliance"
        ? sweepTarget(state, robot, step.params.zone)
        : zoneCenter(field, robot.alliance, step.params.zone);
    case "shoot_on_move":
      return "path" in step.params ? crossingTarget(state, robot, step.params.path) : spotPos(state, robot, step.params.spotId);
    case "defend": {
      // Stand in front of the opponent, on the line from it to the hub it scores in.
      const other = robotById(state, step.params.robotId);
      if (!other || other.alliance === robot.alliance) return null;
      return offsetToward(other.pose, field.alliances[other.alliance].hub, contactDistance(state));
    }
    case "screen":
    case "protect_climber": {
      // Stand between the partner and the closest opponent.
      const partner = robotById(state, step.params.robotId);
      if (!partner || partner.alliance !== robot.alliance || partner.id === robot.id) return null;
      const threat = closestOpponent(state, partner);
      if (!threat) return { x: partner.pose.x, y: partner.pose.y };
      return offsetToward(partner.pose, threat.pose, contactDistance(state));
    }
    case "block_lane": {
      const lane = findLane(field, robot.alliance, step.params.laneId);
      return lane ? { x: (lane.allianceEnd.x + lane.neutralEnd.x) / 2, y: lane.allianceEnd.y } : null;
    }
    case "push_through": {
      const v = directionVector(robot.alliance, step.params.direction);
      const m = state.rules.pinning.releaseDistanceM;
      return { x: robot.pose.x + v.x * m, y: robot.pose.y + v.y * m };
    }
    case "escape_spin":
    case "escape_reverse":
      return escapeTarget(state, robot, step.action, zoneCenter(field, robot.alliance, step.params.exitToward));
    case "disengage":
      return offsetToward(robot.pose, zoneCenter(field, robot.alliance, "our_alliance"), state.rules.pinning.releaseDistanceM);
    case "climb":
      return climbSpot(state, robot);
    default:
      return undefined;
  }
}

/** Centre-to-centre distance at which two robots touch. */
function contactDistance(state: MatchState): number {
  return state.rules.physics.robotRadiusM * 2;
}

function closestOpponent(state: MatchState, robot: RobotState): RobotState | null {
  let best: RobotState | null = null;
  let bestD = Infinity;
  for (const r of state.robots) {
    if (r.alliance === robot.alliance) continue;
    const d = dist(r.pose, robot.pose);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/**
 * Where an escape heads. Reverse: straight away from the robot in contact. Spin: pivot off it,
 * sideways to the contact line on the side facing the exit. Either way the robot ends one pin
 * release distance from where it started.
 */
function escapeTarget(state: MatchState, robot: RobotState, how: "escape_spin" | "escape_reverse", exit: Vec2): Vec2 {
  const m = state.rules.pinning.releaseDistanceM;
  const other = robot.contact.withRobotId ? robotById(state, robot.contact.withRobotId) : null;
  if (!other) return offsetToward(robot.pose, exit, m);
  let ax = robot.pose.x - other.pose.x;
  let ay = robot.pose.y - other.pose.y;
  const ad = Math.hypot(ax, ay) || 1;
  ax /= ad;
  ay /= ad;
  let ex = exit.x - robot.pose.x;
  let ey = exit.y - robot.pose.y;
  const ed = Math.hypot(ex, ey) || 1;
  ex /= ed;
  ey /= ed;
  let dx: number;
  let dy: number;
  if (how === "escape_reverse") {
    dx = ax;
    dy = ay;
  } else {
    // Perpendicular to the contact line, on the exit side, leaning toward the exit.
    const side = -ay * ex + ax * ey >= 0 ? 1 : -1;
    dx = -ay * side + ex;
    dy = ax * side + ey;
    const dd = Math.hypot(dx, dy) || 1;
    dx /= dd;
    dy /= dd;
  }
  return { x: robot.pose.x + dx * m, y: robot.pose.y + dy * m };
}

/**
 * Each robot climbs at its own spot along the field-facing side of its tower, so three partners
 * do not fight over one point. Spot index = the robot's number within its alliance (B1, B2, ...).
 */
function climbSpot(state: MatchState, robot: RobotState): Vec2 {
  const field = state.field;
  const tower = field.alliances[robot.alliance].tower;
  const r = state.rules.physics.robotRadiusM;
  const depth = field.elementSizes?.towerDepthM ?? r * 2;
  const forward = tower.x < field.lengthM / 2 ? 1 : -1;
  const index = Number(robot.id.slice(1)) || 1;
  const lateral = (index - 2) * contactDistance(state);
  return { x: tower.x + forward * (depth / 2 + r), y: tower.y + lateral };
}

/** Top speed and acceleration for the robot's current load. */
function driveLimits(robot: RobotState): { vmax: number; amax: number } {
  const p = robot.profile;
  const fill = p.capacity > 0 ? Math.min(1, robot.fuelHeld / p.capacity) : 0;
  return {
    vmax: p.speedEmptyMps + (p.speedFullMps - p.speedEmptyMps) * fill,
    amax: p.accelEmpty + (p.accelFull - p.accelEmpty) * fill,
  };
}

/** Turn the heading toward `want` at the drivetrain's turn-rate limit. */
function turnToward(robot: RobotState, want: number, dtS: number, maxTurnRateDegPerS: number): void {
  let diff = want - robot.pose.headingRad;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const maxTurn = ((maxTurnRateDegPerS * Math.PI) / 180) * dtS;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
  robot.pose.headingRad = Math.atan2(Math.sin(robot.pose.headingRad + turn), Math.cos(robot.pose.headingRad + turn));
  robot.velocity.omega = turn / dtS;
}

/** Brake toward zero velocity (no navigation this tick). */
function brake(state: MatchState, robot: RobotState, dtS: number): void {
  const { amax } = driveLimits(robot);
  const v = Math.hypot(robot.velocity.vx, robot.velocity.vy);
  if (v <= amax * dtS) {
    robot.velocity.vx = 0;
    robot.velocity.vy = 0;
  } else {
    const k = (v - amax * dtS) / v;
    robot.velocity.vx *= k;
    robot.velocity.vy *= k;
    const grid = getGrid(state.field, state.rules.physics);
    const before = { x: robot.pose.x, y: robot.pose.y };
    robot.pose.x += robot.velocity.vx * dtS;
    robot.pose.y += robot.velocity.vy * dtS;
    resolvePosition(grid, robot.pose, robot.profile.fitsUnderTrench);
    robot.velocity.vx = (robot.pose.x - before.x) / dtS;
    robot.velocity.vy = (robot.pose.y - before.y) / dtS;
  }
  robot.velocity.omega = 0;
}

/**
 * Drive toward a point along the navigation grid, with load-dependent speed and acceleration.
 * Returns true once the robot is at the point (or within stopDistanceM of it and not getting closer).
 */
/** Set by moveToward: true when the last target had no path at all. Read immediately after the call. */
let lastMoveUnreachable = false;

function moveToward(state: MatchState, robot: RobotState, target: Vec2, dtS: number, stopDistanceM: number, follow = false): boolean {
  const physics = state.rules.physics;
  lastMoveUnreachable = false;
  const d = dist(robot.pose, target);
  if (d <= ARRIVE_EXACT_M || (follow && d <= stopDistanceM)) {
    brake(state, robot, dtS);
    return true;
  }
  const grid = getGrid(state.field, physics);
  const fits = robot.profile.fitsUnderTrench;
  const s = steer(grid, robot.pose, target, fits);
  lastMoveUnreachable = s.remainingM === Infinity;
  if (lastMoveUnreachable) {
    brake(state, robot, dtS);
    return false;
  }
  const { vmax: vTop, amax } = driveLimits(robot);
  const vmax = vTop * terrainFactor(grid, robot.pose, physics);
  const toGo = Math.max(0, (follow ? s.remainingM - stopDistanceM : s.remainingM));
  const desiredSpeed = Math.min(vmax, Math.sqrt(2 * amax * toGo));
  const wx = s.waypoint.x - robot.pose.x;
  const wy = s.waypoint.y - robot.pose.y;
  const wd = Math.hypot(wx, wy);
  const dvx0 = wd > EPS ? (wx / wd) * desiredSpeed - robot.velocity.vx : -robot.velocity.vx;
  const dvy0 = wd > EPS ? (wy / wd) * desiredSpeed - robot.velocity.vy : -robot.velocity.vy;
  const dvm = Math.hypot(dvx0, dvy0);
  const k = dvm > amax * dtS ? (amax * dtS) / dvm : 1;
  let vx = robot.velocity.vx + dvx0 * k;
  let vy = robot.velocity.vy + dvy0 * k;
  // Never overshoot the final point when driving straight at it.
  const stepM = Math.hypot(vx, vy) * dtS;
  const before = { x: robot.pose.x, y: robot.pose.y };
  if (s.waypoint === target && stepM >= d) {
    robot.pose.x = target.x;
    robot.pose.y = target.y;
  } else {
    robot.pose.x += vx * dtS;
    robot.pose.y += vy * dtS;
  }
  resolvePosition(grid, robot.pose, fits);
  vx = (robot.pose.x - before.x) / dtS;
  vy = (robot.pose.y - before.y) / dtS;
  robot.velocity.vx = vx;
  robot.velocity.vy = vy;
  const moved = Math.hypot(vx, vy) * dtS;
  if (moved > EPS) turnToward(robot, Math.atan2(vy, vx), dtS, physics.maxTurnRateDegPerS);
  else robot.velocity.omega = 0;

  const p = robot.profile;
  if (p.aimMethod !== "turret" && moved > EPS) {
    robot.alignment.aligned = false;
    robot.alignment.remainingS = p.alignTimeS;
  }
  const left = dist(robot.pose, target);
  if (left <= ARRIVE_EXACT_M) return true;
  // Close enough and no longer making headway (another robot sits on the point): call it arrived.
  return left <= stopDistanceM && moved < physics.arriveToleranceM * dtS;
}

function addScore(state: MatchState, alliance: Alliance, points: number, source: "fuel" | "tower", robotId: RobotId, events: EngineEvent[]): void {
  const score = state.score[alliance];
  const inAuto = state.phase === "auto";
  if (source === "fuel") score[inAuto ? "autoFuel" : "teleopFuel"] += points;
  else score[inAuto ? "autoTower" : "teleopTower"] += points;
  score.total = score.autoFuel + score.teleopFuel + score.autoTower + score.teleopTower + score.foulPoints;
  if (points > 0) events.push({ kind: "score", timeS: state.timeS, alliance, points, source, robotId });
}

/** Accuracy multiplier from a defender in contact (tall robots are easier to defend against). */
function defendedFactor(state: MatchState, robot: RobotState): number {
  const id = robot.contact.withRobotId;
  if (id === null) return 1;
  const other = robotById(state, id);
  if (!other || other.alliance === robot.alliance) return 1;
  const m = state.rules.shotModel;
  return robot.profile.heightClass === "tall" ? m.defendedAccuracyFactorTall : m.defendedAccuracyFactorShort;
}

function hubDistance(state: MatchState, robot: RobotState): number {
  return dist(robot.pose, state.field.alliances[robot.alliance].hub);
}

function inShotRange(state: MatchState, robot: RobotState): boolean {
  const d = hubDistance(state, robot);
  return d >= robot.profile.minShotDistanceM && d <= robot.profile.maxShotDistanceM;
}

/** Piecewise-linear lookup in a sorted table without allocating. */
function lookup<T>(rows: readonly T[], x: number, key: (r: T) => number, val: (r: T) => number): number {
  if (rows.length === 0) return 0;
  if (x <= key(rows[0]!)) return val(rows[0]!);
  for (let i = 1; i < rows.length; i++) {
    const b = rows[i]!;
    if (x <= key(b)) {
      const a = rows[i - 1]!;
      const span = key(b) - key(a);
      const t = span > 0 ? (x - key(a)) / span : 1;
      return val(a) + (val(b) - val(a)) * t;
    }
  }
  return val(rows[rows.length - 1]!);
}

function rowDistance(r: { distanceM: number }): number {
  return r.distanceM;
}
function rowSpeed(r: { speedMps: number }): number {
  return r.speedMps;
}
function rowAccuracy(r: { accuracy: number }): number {
  return r.accuracy;
}

/** Shoot-on-the-move accuracy multiplier at the robot's current ground speed. */
function sotmFactor(robot: RobotState): number {
  return lookup(robot.profile.sotmAccuracyBySpeed, Math.hypot(robot.velocity.vx, robot.velocity.vy), rowSpeed, rowAccuracy);
}

/**
 * Fire held fuel at the robot's own hub at fireRatePerS. Misses (and every shot from outside the
 * shot range) land in the robot's own alliance zone; scored fuel comes back out of the hub.
 * Returns true when the hopper just emptied. Does not finish the action.
 */
function fire(state: MatchState, robot: RobotState, accuracyFactor: number, dtS: number, rng: Rng, events: EngineEvent[]): boolean {
  const p = robot.profile;
  const hubDistM = hubDistance(state, robot);
  const inRange = hubDistM >= p.minShotDistanceM && hubDistM <= p.maxShotDistanceM;
  const accuracy = inRange ? lookup(p.shotAccuracyByDistance, hubDistM, rowDistance, rowAccuracy) * accuracyFactor * defendedFactor(state, robot) : 0;
  const hub = state.hubs[robot.alliance];
  const ownZone: FieldZoneId = `${robot.alliance}_alliance`;

  robot.accum.shot += p.fireRatePerS * dtS;
  while (robot.accum.shot >= 1 && robot.fuelHeld > 0) {
    robot.accum.shot -= 1;
    robot.fuelHeld -= 1;
    if (rng.next() < accuracy) {
      if (hub.active) addScore(state, robot.alliance, state.rules.points.fuelActive, "fuel", robot.id, events);
      else {
        state.score[robot.alliance].fuelInInactiveHub += 1;
        addScore(state, robot.alliance, state.rules.points.fuelInactive, "fuel", robot.id, events);
      }
      state.fuel.byZone[rng.next() < state.rules.shotModel.hubReturnToNeutralFraction ? "neutral" : ownZone] += 1;
    } else {
      state.fuel.byZone[ownZone] += 1;
    }
  }
  if (robot.fuelHeld === 0) {
    robot.accum.shot = 0;
    events.push({ kind: "hopper_empty", timeS: state.timeS, robotId: robot.id });
    return true;
  }
  return false;
}

/**
 * Drivetrain aim: rotate the whole robot to face the hub and settle for alignTimeS.
 * Turret aim: the turret keeps the hub in its sights, so the robot is always aligned.
 * Returns true once aligned.
 */
function align(state: MatchState, robot: RobotState, dtS: number): boolean {
  if (robot.profile.aimMethod === "turret") {
    robot.alignment.aligned = true;
    robot.alignment.remainingS = 0;
    return true;
  }
  if (robot.alignment.aligned) return true;
  if (dtS <= 0) return false;
  const hub = state.field.alliances[robot.alliance].hub;
  turnToward(robot, Math.atan2(hub.y - robot.pose.y, hub.x - robot.pose.x), dtS, state.rules.physics.maxTurnRateDegPerS);
  robot.alignment.remainingS = Math.max(0, robot.alignment.remainingS - dtS);
  if (robot.alignment.remainingS <= EPS) {
    robot.alignment.aligned = true;
    robot.alignment.remainingS = 0;
  }
  return robot.alignment.aligned;
}

/** Spin the shooter up; returns true once at speed. */
function spinUp(robot: RobotState, dtS: number): boolean {
  if (robot.spinUp.ready) return true;
  robot.spinUp.remainingS = Math.max(0, robot.spinUp.remainingS - dtS);
  if (robot.spinUp.remainingS <= EPS) {
    robot.spinUp.ready = true;
    robot.spinUp.remainingS = 0;
  }
  return robot.spinUp.ready;
}

/** Let the shooter wind down (during any step that is not about shooting). */
function spinDown(robot: RobotState): void {
  robot.spinUp.ready = false;
  robot.spinUp.remainingS = robot.profile.spinUpS;
}

type ShotMode = "now" | "align" | "dump" | "move" | "hold";

/**
 * One tick of a shooting step, by archetype:
 *   - drum / lanes (drivetrain aim): align first (unless shooting unaligned), then spin up, then fire
 *   - turret: always aligned, spins up while driving, fires on the move if it can
 *   - dumper: only scores from right next to the hub; refuses to fire from anywhere else
 * Finishes the step when the hopper empties.
 */
function shootStep(state: MatchState, robot: RobotState, mode: ShotMode, dtS: number, rng: Rng, events: EngineEvent[]): void {
  const p = robot.profile;
  if (p.shooterType === "none" || p.fireRatePerS <= 0) return finish(state, robot, events, "no_shooter");
  if (robot.fuelHeld <= 0) return finish(state, robot, events, "no_fuel");
  if (mode === "move" && !p.shootOnMove) return finish(state, robot, events, "cannot_shoot_on_move");
  if (p.shooterType === "dumper" && mode !== "move" && !inShotRange(state, robot)) return finish(state, robot, events, "out_of_range");

  let factor = 1;
  if (mode === "dump") factor = state.rules.shotModel.dumpUnalignedAccuracyFactor;
  else if (mode === "move") {
    align(state, robot, dtS);
    factor = sotmFactor(robot);
  } else if (mode === "now") {
    if (!align(state, robot, 0)) factor = state.rules.shotModel.dumpUnalignedAccuracyFactor;
  } else if (!align(state, robot, dtS)) {
    spinDown(robot); // "align, then spin up": the shooter waits for the drivetrain
    return;
  }
  if (!spinUp(robot, dtS)) return;
  if (mode === "hold" && !state.hubs[robot.alliance].active) return;
  if (mode === "move" && !inShotRange(state, robot)) return; // keep driving until the hub is in range
  if (fire(state, robot, factor, dtS, rng, events)) finish(state, robot, events);
}

/**
 * Collect-while-shooting turrets (the zero-hopper archetype) fire whatever they pick up as long
 * as the hub is in range and active, so they score almost as fast as they collect.
 * Returns true when it is shooting (or spinning up to shoot) this tick.
 */
function fireWhileCollecting(state: MatchState, robot: RobotState, dtS: number, rng: Rng, events: EngineEvent[]): boolean {
  const p = robot.profile;
  if (!p.canCollectWhileShooting || p.aimMethod !== "turret" || p.shooterType === "none" || p.fireRatePerS <= 0) return false;
  if (robot.fuelHeld <= 0 || !state.hubs[robot.alliance].active || !inShotRange(state, robot)) return false;
  align(state, robot, dtS);
  if (!spinUp(robot, dtS)) return true;
  fire(state, robot, p.shootOnMove ? sotmFactor(robot) : 1, dtS, rng, events);
  return true;
}

/** Index of the fuel pile under the robot (within reach of its intake), or -1. */
function pileUnder(state: MatchState, robot: RobotState): number {
  const reach = state.rules.physics.robotRadiusM + state.rules.physics.arriveToleranceM;
  const piles = state.fuel.piles;
  for (let i = 0; i < piles.length; i++) if (dist(piles[i]!.pos, robot.pose) <= reach) return i;
  return -1;
}

/**
 * Take fuel from a pile under the robot, else from a floor zone. Finishes when the hopper is full
 * (unless keepGoing: a collect-while-shooting robot that empties as it fills); fails when the
 * source is empty.
 */
function intake(state: MatchState, robot: RobotState, zone: FieldZoneId, dtS: number, events: EngineEvent[], keepGoing = false): void {
  const p = robot.profile;
  if (p.capacity <= 0 || p.intakeRatePerS <= 0) return finish(state, robot, events, "cannot_collect");
  if (robot.fuelHeld >= p.capacity) {
    if (!keepGoing) finish(state, robot, events);
    return;
  }
  const pile = pileUnder(state, robot);
  if (pile < 0 && state.fuel.byZone[zone] <= 0) return finish(state, robot, events, "source_empty");
  robot.accum.intake += p.intakeRatePerS * dtS;
  const avail = pile >= 0 ? state.fuel.piles[pile]!.count : state.fuel.byZone[zone];
  const taken = Math.min(Math.floor(robot.accum.intake), avail, p.capacity - robot.fuelHeld);
  robot.accum.intake -= taken;
  robot.fuelHeld += taken;
  if (pile >= 0) {
    state.fuel.piles[pile]!.count -= taken;
    if (state.fuel.piles[pile]!.count <= 0) state.fuel.piles.splice(pile, 1);
  } else state.fuel.byZone[zone] -= taken;
  if (robot.fuelHeld >= p.capacity) {
    robot.accum.intake = 0;
    if (!keepGoing) {
      events.push({ kind: "hopper_full", timeS: state.timeS, robotId: robot.id });
      finish(state, robot, events);
    }
  }
}

function pass(state: MatchState, robot: RobotState, step: Extract<IntentStep, { action: "pass_to" }>, dtS: number, events: EngineEvent[]): void {
  const p = robot.profile;
  if (robot.fuelHeld <= 0) return finish(state, robot, events, "no_fuel");
  if (p.passRatePerS <= 0) return finish(state, robot, events, "cannot_pass");
  const partner = "robotId" in step.params ? state.robots.find((r) => r.id === (step.params as { robotId: string }).robotId) : undefined;
  if ("robotId" in step.params) {
    if (!partner || partner.alliance !== robot.alliance) return finish(state, robot, events, "bad_target");
    if (dist(robot.pose, partner.pose) > p.passRangeM) return finish(state, robot, events, "out_of_range");
    if (partner.fuelHeld >= partner.profile.capacity) return finish(state, robot, events);
  }
  robot.accum.pass += p.passRatePerS * dtS;
  let n = Math.min(Math.floor(robot.accum.pass), robot.fuelHeld);
  if (partner) n = Math.min(n, partner.profile.capacity - partner.fuelHeld);
  robot.accum.pass -= n;
  robot.fuelHeld -= n;
  if (partner) partner.fuelHeld += n;
  else if ("zone" in step.params) state.fuel.byZone[fieldZoneOf(robot.alliance, step.params.zone)] += n;
  if (robot.fuelHeld === 0) {
    robot.accum.pass = 0;
    events.push({ kind: "hopper_empty", timeS: state.timeS, robotId: robot.id });
    finish(state, robot, events);
  }
}

function climb(state: MatchState, robot: RobotState, level: number, dtS: number, events: EngineEvent[]): void {
  if (level > robot.profile.climbLevel) return finish(state, robot, events, "cannot_climb");
  if (!robot.climb.inProgress) {
    robot.climb = { level: 0, inProgress: true, targetLevel: level, remainingS: climbTimeForLevel(robot.profile, level) };
  }
  robot.climb.remainingS = Math.max(0, robot.climb.remainingS - dtS);
  if (robot.climb.remainingS > EPS) return;
  robot.climb = { level, inProgress: false, targetLevel: 0, remainingS: 0 };
  const points = state.phase === "auto" ? (level === 1 ? state.rules.points.towerAutoL1 : 0) : (state.rules.points.towerTeleop[level - 1] ?? 0);
  addScore(state, robot.alliance, points, "tower", robot.id, events);
  finish(state, robot, events);
}

/** True when p lies inside the physical crossing rectangle of a lane. */
function inLane(state: MatchState, lane: { allianceEnd: Vec2; neutralEnd: Vec2 }, p: Vec2): boolean {
  const sz = state.field.elementSizes;
  const halfW = (sz ? Math.max(sz.trenchWidthM, sz.bumpWidthM) : state.rules.physics.robotRadiusM * 4) / 2;
  const x0 = Math.min(lane.allianceEnd.x, lane.neutralEnd.x);
  const x1 = Math.max(lane.allianceEnd.x, lane.neutralEnd.x);
  return p.x >= x0 && p.x <= x1 && Math.abs(p.y - lane.allianceEnd.y) <= halfW;
}

/**
 * For route_via / shoot_on_move along a route: drive to the near end of the chosen crossing
 * first, so the robot really uses that crossing, then on to the far end (the step's navTarget).
 */
function crossingWaypoint(state: MatchState, robot: RobotState, route: RouteId, farEnd: Vec2): Vec2 {
  const lane = state.field.lanes.find((l) => l.side === robot.alliance && l.route === route);
  if (!lane) return farEnd;
  const nearEnd = dist(farEnd, lane.neutralEnd) < dist(farEnd, lane.allianceEnd) ? lane.allianceEnd : lane.neutralEnd;
  if (inLane(state, lane, robot.pose)) return farEnd;
  const nearZone = floorZoneAt(state.field, nearEnd);
  if (floorZoneAt(state.field, robot.pose) !== nearZone) return farEnd;
  if (dist(robot.pose, nearEnd) <= state.rules.physics.arriveToleranceM) return farEnd;
  return nearEnd;
}

/** Update the no-progress timer; emits no_progress (and path_blocked when another robot is in the way). */
function trackProgress(state: MatchState, robot: RobotState, before: Vec2, arrived: boolean, dtS: number, events: EngineEvent[]): void {
  const { noProgressS, noProgressMinMoveM } = state.rules.triggers;
  const moved = dist(before, robot.pose);
  if (arrived || moved >= (noProgressMinMoveM / noProgressS) * dtS) {
    robot.noProgressS = 0;
    return;
  }
  const prev = robot.noProgressS;
  robot.noProgressS = prev + dtS;
  if (Math.floor((robot.noProgressS + EPS) / noProgressS) > Math.floor((prev + EPS) / noProgressS)) {
    events.push({ kind: "no_progress", timeS: state.timeS, robotId: robot.id, seconds: robot.noProgressS });
    if (robot.contact.withRobotId !== null) {
      events.push({ kind: "path_blocked", timeS: state.timeS, robotId: robot.id, byRobotId: robot.contact.withRobotId });
    }
  }
}

/** Set by advanceRobot: true when the robot tried to move this tick and has not arrived. */
let wantsToMove = false;

function advanceRobot(state: MatchState, robot: RobotState, dtS: number, rng: Rng, events: EngineEvent[]): void {
  wantsToMove = false;
  const step = currentStep(robot);
  if (!step) {
    brake(state, robot, dtS);
    return;
  }
  const physics = state.rules.physics;
  const follows = step.action === "defend" || step.action === "screen" || step.action === "protect_climber";
  if (!SHOOTING.has(step.action) && !(step.action === "collect" && robot.profile.canCollectWhileShooting)) spinDown(robot);
  if (!robot.profile.fitsUnderTrench) {
    const route = step.action === "route_via" ? step.params.route : step.action === "shoot_on_move" && "path" in step.params ? step.params.path : null;
    const trenchLane = step.action === "block_lane" && step.params.laneId.endsWith("_trench");
    if (trenchLane || (route !== null && isTrench(route))) return finish(state, robot, events, "cannot_fit");
  }

  // Navigation target: fixed at step start, except when following another robot.
  let arrived = true;
  if (robot.navTarget === null || follows) {
    const target = resolveTarget(state, robot, step);
    if (target === null) return finish(state, robot, events, "bad_target");
    robot.navTarget = target === undefined ? null : snapTarget(getGrid(state.field, physics), target, robot.profile.fitsUnderTrench);
  }
  if (robot.navTarget !== null) {
    const route = step.action === "route_via" ? step.params.route : step.action === "shoot_on_move" && "path" in step.params ? step.params.path : null;
    const goal = route ? crossingWaypoint(state, robot, route, robot.navTarget) : robot.navTarget;
    const before = { x: robot.pose.x, y: robot.pose.y };
    // Followers (defend, screen, protect) drive right up to their point so they really make contact.
    const stopM = follows ? Math.min(physics.arriveToleranceM, physics.contactMarginM ?? physics.arriveToleranceM) : physics.arriveToleranceM;
    arrived = moveToward(state, robot, goal, dtS, stopM, follows);
    if (!arrived) wantsToMove = true;
    if (goal !== robot.navTarget) arrived = false;
    trackProgress(state, robot, before, arrived, dtS, events);
    if (lastMoveUnreachable) {
      events.push({ kind: "path_blocked", timeS: state.timeS, robotId: robot.id, byRobotId: null });
      return finish(state, robot, events, "unreachable");
    }
  } else {
    brake(state, robot, dtS);
  }

  switch (step.action) {
    case "goto_zone":
    case "goto_shot_spot":
    case "route_via":
    case "push_through":
    case "escape_spin":
    case "escape_reverse":
    case "disengage":
      if (arrived) finish(state, robot, events);
      break;
    case "hold_position":
    case "defend":
    case "block_lane":
    case "screen":
    case "protect_climber":
      break; // continuous: runs until replaced
    case "collect": {
      // Loose floor fuel is picked up as soon as the robot is in the zone; the depot needs arrival.
      const here = floorZoneAt(state.field, robot.pose);
      const zone: FieldZoneId = step.params.source === "neutral" ? "neutral" : step.params.source === "depot" ? `${robot.alliance}_depot` : here;
      const firing = fireWhileCollecting(state, robot, dtS, rng, events);
      if (step.params.source === "depot" ? arrived : here === zone) intake(state, robot, zone, dtS, events, firing);
      break;
    }
    case "load_outpost":
      if (arrived) intake(state, robot, `${robot.alliance}_outpost`, dtS, events);
      break;
    case "steal_fuel": {
      const zone = fieldZoneOf(robot.alliance, step.params.zone);
      if (arrived || floorZoneAt(state.field, robot.pose) === zone) intake(state, robot, zone, dtS, events);
      break;
    }
    case "shoot_now":
      shootStep(state, robot, "now", dtS, rng, events);
      break;
    case "dump_unaligned":
      shootStep(state, robot, "dump", dtS, rng, events);
      break;
    case "align_then_shoot":
      shootStep(state, robot, "align", dtS, rng, events);
      break;
    case "hold_fire_until_active":
      shootStep(state, robot, "hold", dtS, rng, events);
      break;
    case "shoot_on_move": {
      const wasIntent = robot.intent;
      shootStep(state, robot, "move", dtS, rng, events);
      if (robot.intent === wasIntent && currentStep(robot) === step && arrived) finish(state, robot, events); // reached the end of the path
      break;
    }
    case "stage_fuel":
      if (robot.fuelHeld <= 0) finish(state, robot, events, "no_fuel");
      else if (arrived) {
        state.fuel.piles.push({
          id: `pile_${state.tick}_${robot.id}`,
          pos: { x: robot.pose.x, y: robot.pose.y },
          count: robot.fuelHeld,
          zone: floorZoneAt(state.field, robot.pose),
          stagedBy: robot.alliance,
        });
        robot.fuelHeld = 0;
        events.push({ kind: "hopper_empty", timeS: state.timeS, robotId: robot.id });
        finish(state, robot, events);
      }
      break;
    case "pass_to":
      pass(state, robot, step, dtS, events);
      break;
    case "climb":
      if (arrived) climb(state, robot, step.params.level, dtS, events);
      break;
    case "abort_climb":
      robot.climb = { level: 0, inProgress: false, targetLevel: 0, remainingS: 0 };
      finish(state, robot, events);
      break;
  }
}

// ── contact, proximity, watchdog ─────────────────────────────────────────────

/** Traction limit: the most force the robot's wheels can put on the carpet, newtons. */
function gripForce(state: MatchState, robot: RobotState): number {
  const p = robot.profile;
  return p.traction * loadedMassKg(p, robot.fuelHeld) * (state.rules.physics.gravityMps2 ?? DEFAULT_GRAVITY);
}

/** Force with which the robot drives along (tx, ty) into the robot it touches; 0 when it is not driving into it. */
function pushingForce(state: MatchState, robot: RobotState, tx: number, ty: number, trying: boolean): number {
  if (!trying || robot.velocity.vx * tx + robot.velocity.vy * ty <= EPS) return 0;
  return Math.min(robot.profile.pushForceN, gripForce(state, robot));
}

/**
 * Push model. Robots are solid discs. When two overlap, a robot driving into the other pushes
 * with its drive force (capped by its traction); a robot that is not pushing back resists with
 * its traction. The pushed robot gives way only by the pusher's excess force, as a fraction of
 * the push, and the pusher is stopped by the rest: a weak robot cannot shove a strong one that
 * holds its ground, and two robots pushing head-on move the way of the stronger. Both then slide
 * out of any field element. Pairs are processed in fixed state order.
 */
function separateRobots(state: MatchState, trying: Uint8Array): void {
  const robots = state.robots;
  const touch = contactDistance(state);
  const grid = getGrid(state.field, state.rules.physics);
  for (let i = 0; i < robots.length; i++) {
    const a = robots[i]!;
    const aFixed = a.climb.level > 0 || a.climb.inProgress; // on the tower: does not move
    for (let j = i + 1; j < robots.length; j++) {
      const b = robots[j]!;
      const bFixed = b.climb.level > 0 || b.climb.inProgress;
      if (aFixed && bFixed) continue;
      const dx = b.pose.x - a.pose.x;
      const dy = b.pose.y - a.pose.y;
      const d = Math.hypot(dx, dy);
      if (d >= touch) continue;
      const ux = d > EPS ? dx / d : 1;
      const uy = d > EPS ? dy / d : 0;
      const overlap = touch - d;
      const pa = pushingForce(state, a, ux, uy, trying[i] === 1);
      const pb = pushingForce(state, b, -ux, -uy, trying[j] === 1);
      // Fraction of the overlap that robot a gives up (b gives up the rest).
      let shareA: number;
      if (pa > 0 && pb > 0) shareA = pa >= pb ? 1 - (pa - pb) / pa : (pb - pa) / pb;
      else if (pa > 0) shareA = 1 - Math.max(0, Math.min(1, (pa - gripForce(state, b)) / pa));
      else if (pb > 0) shareA = Math.max(0, Math.min(1, (pb - gripForce(state, a)) / pb));
      else shareA = 0.5;
      if (aFixed) shareA = 0;
      else if (bFixed) shareA = 1;
      a.pose.x -= ux * overlap * shareA;
      a.pose.y -= uy * overlap * shareA;
      b.pose.x += ux * overlap * (1 - shareA);
      b.pose.y += uy * overlap * (1 - shareA);
      resolvePosition(grid, a.pose, a.profile.fitsUnderTrench);
      resolvePosition(grid, b.pose, b.profile.fitsUnderTrench);
    }
  }
}

/** True while a robot touches its own tower: climbing or hanging, or bumpers against the footprint. */
function touchesOwnTower(state: MatchState, robot: RobotState): boolean {
  if (robot.climb.inProgress || robot.climb.level > 0) return true;
  const physics = state.rules.physics;
  const tower = state.field.alliances[robot.alliance].tower;
  const r = physics.robotRadiusM;
  const sz = state.field.elementSizes;
  const dx = Math.max(0, Math.abs(robot.pose.x - tower.x) - (sz ? sz.towerDepthM / 2 : 0));
  const dy = Math.max(0, Math.abs(robot.pose.y - tower.y) - (sz ? sz.towerWidthM / 2 : 0));
  return Math.hypot(dx, dy) <= r + (physics.contactMarginM ?? 0) + EPS;
}

/**
 * Tower protection (MatchState.rules.towerProtection, rule G420): in the last `lastS` seconds,
 * any contact with an opponent robot that touches its own tower is a foul on the contacting
 * robot, whoever started it; one call per contact. If the victim is off the ground it is awarded
 * the tower points of `offGroundAwardLevel` (less any tower points it already earned) and its
 * climb counts as done at that level. Transitive contact through fuel is not modelled.
 */
function updateTowerProtection(state: MatchState, events: EngineEvent[]): void {
  const tp = state.rules.towerProtection;
  if (!tp) return;
  const inWindow = state.timeS >= state.rules.matchS - tp.lastS - EPS;
  const touch = contactDistance(state) + (state.rules.physics.contactMarginM ?? 0);
  for (const victim of state.robots) {
    const called = victim.contact.towerFoulBy;
    if (!inWindow && called === undefined) continue;
    const next: RobotId[] = [];
    for (const opp of state.robots) {
      if (opp.alliance === victim.alliance || dist(opp.pose, victim.pose) > touch) continue;
      if (called?.includes(opp.id)) {
        next.push(opp.id);
        continue;
      }
      if (!inWindow || !touchesOwnTower(state, victim)) continue;
      next.push(opp.id);
      callFoul(state, opp, tp.clauseId, tp.severity, events);
      if (victim.climb.inProgress || victim.climb.level > 0) {
        const pts = state.rules.points.towerTeleop;
        const already = victim.climb.level > 0 ? (pts[victim.climb.level - 1] ?? 0) : 0;
        const award = Math.max(0, (pts[tp.offGroundAwardLevel - 1] ?? 0) - already);
        const level = Math.max(victim.climb.level, tp.offGroundAwardLevel);
        victim.climb = { level, inProgress: false, targetLevel: 0, remainingS: 0 };
        if (award > 0) addScore(state, victim.alliance, award, "tower", victim.id, events);
        if (currentStep(victim)?.action === "climb") finish(state, victim, events);
      }
    }
    if (next.length > 0 || called !== undefined) victim.contact.towerFoulBy = next;
  }
}

/** Record a foul by `robot`: points to the other alliance, a FoulRecord and a foul event. */
function callFoul(state: MatchState, robot: RobotState, clauseId: string, severity: "minor" | "major", events: EngineEvent[]): void {
  const points = severity === "major" ? state.rules.points.majorFoul : state.rules.points.minorFoul;
  const victim = state.score[otherAlliance(robot.alliance)];
  victim.foulPoints += points;
  victim.total = victim.autoFuel + victim.teleopFuel + victim.autoTower + victim.teleopTower + victim.foulPoints;
  state.fouls.push({ timeS: state.timeS, clauseId, byRobotId: robot.id, byAlliance: robot.alliance, severity, pointsToOpponent: points });
  events.push({ kind: "foul", timeS: state.timeS, clauseId, robotId: robot.id, severity, pointsToOpponent: points });
}

/**
 * Pins (rule G418 in config). A robot is pinned while it is trying to move, makes no headway, and
 * an opponent in contact is driving into it. The count pauses when the pin is broken and ends
 * only once the pinner is more than the release distance away. `pinned` fires once the pin has
 * lasted triggers.contactLongS; at pinning.limitS the pinner is called for a foul and the count
 * restarts.
 */
function updatePins(state: MatchState, startX: Float64Array, startY: Float64Array, trying: Uint8Array, dtS: number, events: EngineEvent[]): void {
  const robots = state.robots;
  const { noProgressS, noProgressMinMoveM, contactLongS } = state.rules.triggers;
  const pin = state.rules.pinning;
  const stuckM = (noProgressMinMoveM / noProgressS) * dtS;
  for (let i = 0; i < robots.length; i++) {
    const robot = robots[i]!;
    const c = robot.contact;
    const other = c.withRobotId !== null ? robotById(state, c.withRobotId) : null;
    let pinner: RobotState | null = null;
    if (other && other.alliance !== robot.alliance && trying[i] === 1) {
      // Headway toward where it is going (being shoved backwards is no headway either).
      const goal = robot.navTarget;
      const moved = goal
        ? Math.hypot(goal.x - startX[i]!, goal.y - startY[i]!) - Math.hypot(goal.x - robot.pose.x, goal.y - robot.pose.y)
        : Math.hypot(robot.pose.x - startX[i]!, robot.pose.y - startY[i]!);
      const tx = robot.pose.x - other.pose.x;
      const ty = robot.pose.y - other.pose.y;
      // The opponent pins only if it is the one holding: driving into this robot (or defending it)
      // with at least the force this robot pushes back with.
      const td = Math.hypot(tx, ty) || 1;
      const j = robots.indexOf(other);
      const theirs = pushingForce(state, other, tx / td, ty / td, trying[j] === 1);
      const ours = pushingForce(state, robot, -tx / td, -ty / td, true);
      const holding = theirs > 0 ? theirs : currentStep(other)?.action === "defend" ? gripForce(state, other) : 0;
      const into = holding > 0 && holding >= ours;
      if (moved < stuckM && into) pinner = other;
    }
    if (pinner) {
      if (c.pinnedByRobotId !== pinner.id) {
        c.pinnedByRobotId = pinner.id;
        c.pinS = 0;
      }
      const before = c.pinS;
      c.pinS = before + dtS;
      if (before < contactLongS && c.pinS >= contactLongS) events.push({ kind: "pinned", timeS: state.timeS, robotId: robot.id, seconds: c.pinS });
      if (c.pinS >= pin.limitS - EPS) {
        callFoul(state, pinner, pin.clauseId, pin.severity, events);
        c.pinS = 0;
      }
    } else if (c.pinnedByRobotId !== null) {
      const by = robotById(state, c.pinnedByRobotId);
      if (!by || dist(by.pose, robot.pose) - contactDistance(state) >= pin.releaseDistanceM) {
        c.pinnedByRobotId = null;
        c.pinS = 0;
      }
    }
  }
}

/** Pairs (i < j, opposing alliances) within opponentInRangeM, as a flat n*n flag array. */
function opponentsInRange(state: MatchState): Uint8Array {
  const robots = state.robots;
  const n = robots.length;
  const near = new Uint8Array(n * n);
  const range = state.rules.triggers.opponentInRangeM;
  for (let i = 0; i < n; i++) {
    const a = robots[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = robots[j]!;
      if (a.alliance !== b.alliance && dist(a.pose, b.pose) <= range) near[i * n + j] = 1;
    }
  }
  return near;
}

function updateContacts(state: MatchState, dtS: number, wasNear: Uint8Array, events: EngineEvent[]): void {
  const t = state.timeS;
  const touchM = state.rules.physics.robotRadiusM * 2 + (state.rules.physics.contactMarginM ?? 0);
  const longS = state.rules.triggers.contactLongS;
  const robots = state.robots;
  const n = robots.length;

  for (let i = 0; i < n; i++) {
    const robot = robots[i]!;
    let other: RobotState | null = null;
    for (let j = 0; j < n; j++) {
      if (j !== i && dist(robot.pose, robots[j]!.pose) <= touchM) {
        other = robots[j]!;
        break;
      }
    }
    if (!other) {
      robot.contact.withRobotId = null;
      robot.contact.contactS = 0;
      continue;
    }
    if (robot.contact.withRobotId !== other.id) {
      robot.contact.withRobotId = other.id;
      robot.contact.contactS = 0;
      events.push({ kind: "contact_start", timeS: t, robotId: robot.id, otherRobotId: other.id });
    }
    const before = robot.contact.contactS;
    robot.contact.contactS = before + dtS;
    if (before < longS && robot.contact.contactS >= longS) {
      events.push({ kind: "contact_long", timeS: t, robotId: robot.id, seconds: robot.contact.contactS });
    }
  }

  const nowNear = opponentsInRange(state);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (nowNear[i * n + j] && !wasNear[i * n + j]) {
        const a = robots[i]!;
        const b = robots[j]!;
        const distanceM = dist(a.pose, b.pose);
        events.push({ kind: "opponent_in_range", timeS: t, robotId: a.id, opponentId: b.id, distanceM });
        events.push({ kind: "opponent_in_range", timeS: t, robotId: b.id, opponentId: a.id, distanceM });
      }
    }
  }
}

/** True when `elapsed` crossed a multiple of `every` during the last dtS. */
function crossed(elapsed: number, dtS: number, every: number): boolean {
  return elapsed > EPS && Math.floor((elapsed + EPS) / every) > Math.floor((elapsed - dtS + EPS) / every);
}

function timers(state: MatchState, dtS: number, events: EngineEvent[]): void {
  const t = state.timeS;
  const { watchdogS, actionTimeoutS } = state.rules.triggers;
  for (const robot of state.robots) {
    const sinceDecision = t - robot.lastDecisionS;
    if (crossed(sinceDecision, dtS, watchdogS)) {
      events.push({ kind: "watchdog", timeS: t, robotId: robot.id, secondsSinceDecision: sinceDecision });
    }
    const step = currentStep(robot);
    const running = t - robot.intentStartedS;
    if (step && !CONTINUOUS.has(step.action) && running < actionTimeoutS * 2 && crossed(running, dtS, actionTimeoutS)) {
      events.push({ kind: "action_timeout", timeS: t, robotId: robot.id, action: step.action, elapsedS: running });
    }
  }
}

// ── step, snapshot, restore, rollout ─────────────────────────────────────────

function step(state: MatchState, intents: Record<RobotId, Intent | undefined>, dtS: number): StepResult {
  const events: EngineEvent[] = [];
  if (state.phase === "finished") return { state, events };
  const rng = Rng.fromState(state.rngState);

  for (const robot of state.robots) {
    const next = intents[robot.id];
    if (next === undefined) continue;
    robot.intent = next;
    robot.intentStage = "primary";
    robot.intentStartedS = state.timeS;
    robot.lastDecisionS = state.timeS;
    robot.navTarget = null;
    robot.noProgressS = 0;
  }

  const wasNear = opponentsInRange(state);
  const n = state.robots.length;
  const startX = new Float64Array(n);
  const startY = new Float64Array(n);
  const trying = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const robot = state.robots[i]!;
    startX[i] = robot.pose.x;
    startY[i] = robot.pose.y;
    advanceRobot(state, robot, dtS, rng, events);
    trying[i] = wantsToMove ? 1 : 0;
  }
  separateRobots(state, trying);
  advanceClock(state, dtS, rng, events);
  updateContacts(state, dtS, wasNear, events);
  updatePins(state, startX, startY, trying, dtS, events);
  updateTowerProtection(state, events);
  timers(state, dtS, events);

  state.tick += 1;
  state.rngState = rng.getState();
  return { state, events };
}

function snapshot(state: MatchState): Snapshot {
  return { schemaVersion: STATE_SCHEMA_VERSION, takenAtS: state.timeS, state: structuredClone(state) };
}

function restore(snap: Snapshot): MatchState {
  if (snap.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error(`snapshot schema ${snap.schemaVersion} != ${STATE_SCHEMA_VERSION}`);
  return structuredClone(snap.state);
}

function rollout(
  snap: Snapshot,
  overrides: Record<RobotId, Intent>,
  horizonS: number,
  seed: number,
  policies: RolloutPolicies,
  options?: RolloutOptions,
): RolloutResult {
  const state = restore(snap);
  state.rngState = seedState(seed);

  const overridden = new Set(Object.keys(overrides));
  const overrideAlliances = new Set(state.robots.filter((r) => overridden.has(r.id)).map((r) => r.alliance));
  if (!options?.perspective && overrideAlliances.size > 1) throw new Error("rollout: overrides span both alliances; pass options.perspective");
  const perspective: Alliance = options?.perspective ?? [...overrideAlliances][0] ?? "red";
  const other = otherAlliance(perspective);

  const startFor = state.score[perspective].total;
  const startAgainst = state.score[other].total;
  const startFouls = state.fouls.length;

  const dtS = state.rules.physics.dtS;
  const endS = Math.min(state.timeS + horizonS, state.rules.matchS);
  let pending: Record<RobotId, Intent | undefined> = { ...overrides };
  // Same decision rule as a live match (src/exec/triggers.ts): a robot decides when it is idle or
  // when an event triggers it, and sees the events since its previous decision.
  const n = state.robots.length;
  const since: EngineEvent[][] = state.robots.map(() => []);
  const triggered = new Uint8Array(n);

  while (state.timeS < endS - EPS && state.phase !== "finished") {
    for (let i = 0; i < n; i++) {
      const robot = state.robots[i]!;
      if (pending[robot.id] !== undefined) continue;
      if (overridden.has(robot.id)) {
        if (robot.intent !== null) continue; // override still running
        overridden.delete(robot.id);
      }
      if (robot.intent === null || triggered[i]) {
        const policy = policies.byRobot?.[robot.id] ?? policies.default;
        pending[robot.id] = policy.decide(buildObservationView(state, robot.id, since[i]));
        since[i] = [];
      }
    }
    const { events } = step(state, pending, dtS);
    pending = {};
    triggered.fill(0);
    if (events.length > 0) {
      for (let i = 0; i < n; i++) {
        const id = state.robots[i]!.id;
        const buf = since[i]!;
        for (const e of events) {
          if (!eventConcerns(e, id)) continue;
          buf.push(e);
          if (isTriggerFor(e, id)) triggered[i] = 1;
        }
        if (buf.length > 50) since[i] = buf.slice(-50);
      }
    }
  }

  const newFouls = state.fouls.slice(startFouls);
  return {
    pointsFor: state.score[perspective].total - startFor,
    pointsAgainst: state.score[other].total - startAgainst,
    foulsFor: newFouls.filter((f) => f.byAlliance === perspective).length,
    foulsAgainst: newFouls.filter((f) => f.byAlliance === other).length,
    finalSnapshot: snapshot(state),
  };
}

/** The real engine. Import `engine` from "./index" rather than this directly. */
export const rebuiltEngine: Engine = { createMatch, step, snapshot, restore, rollout };
