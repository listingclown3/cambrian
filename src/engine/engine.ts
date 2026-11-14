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
  interpTable,
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
import { buildObservationView } from "./observe";
import { getGrid, resolvePosition, snapTarget, steer, terrainFactor } from "./nav";

const EPS = 1e-9;
/** A point target counts as reached once the robot centre is this close, metres (well below any tolerance). */
const ARRIVE_EXACT_M = 1e-3;

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

  for (const alliance of ALLIANCES) {
    const hub = state.hubs[alliance];
    hub.active = hubActiveAt(state, alliance, t);
    const next = boundaries(state).find((b) => b > t + EPS && hubActiveAt(state, alliance, b) !== hub.active);
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
function resolveTarget(state: MatchState, robot: RobotState, step: IntentStep): Vec2 | null | undefined {
  const field = state.field;
  const spot = (id: string) => field.shotSpots.find((s) => s.alliance === robot.alliance && s.id === id)?.pos ?? null;
  const robotPos = (id: RobotId) => {
    const other = state.robots.find((r) => r.id === id);
    return other ? { x: other.pose.x, y: other.pose.y } : null;
  };
  switch (step.action) {
    case "goto_zone":
      return zoneCenter(field, robot.alliance, step.params.zone);
    case "goto_shot_spot":
    case "stage_fuel":
      return spot(step.params.spotId);
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
      return "path" in step.params ? crossingTarget(state, robot, step.params.path) : spot(step.params.spotId);
    case "defend":
    case "screen":
    case "protect_climber":
      return robotPos(step.params.robotId);
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
      return offsetToward(robot.pose, zoneCenter(field, robot.alliance, step.params.exitToward), state.rules.pinning.releaseDistanceM);
    case "disengage":
      return offsetToward(robot.pose, zoneCenter(field, robot.alliance, "our_alliance"), state.rules.pinning.releaseDistanceM);
    case "climb":
      return field.alliances[robot.alliance].tower;
    default:
      return undefined;
  }
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

/** Fire held fuel at the robot's own hub. Finishes the action when the hopper is empty. */
function fire(state: MatchState, robot: RobotState, accuracyFactor: number, dtS: number, rng: Rng, events: EngineEvent[]): void {
  const p = robot.profile;
  if (p.shooterType === "none" || p.fireRatePerS <= 0) return finish(state, robot, events, "no_shooter");
  if (robot.fuelHeld <= 0) return finish(state, robot, events, "no_fuel");

  const hubDistM = dist(robot.pose, state.field.alliances[robot.alliance].hub);
  const inRange = hubDistM >= p.minShotDistanceM && hubDistM <= p.maxShotDistanceM;
  const table = p.shotAccuracyByDistance.map((row) => ({ x: row.distanceM, y: row.accuracy }));
  const accuracy = inRange ? interpTable(table, hubDistM) * accuracyFactor : 0;
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
    finish(state, robot, events);
  }
}

/** Align to the hub; returns true once aligned. */
function align(robot: RobotState, dtS: number): boolean {
  if (robot.alignment.aligned) return true;
  robot.alignment.remainingS = Math.max(0, robot.alignment.remainingS - dtS);
  if (robot.alignment.remainingS <= EPS) {
    robot.alignment.aligned = true;
    robot.alignment.remainingS = 0;
  }
  return robot.alignment.aligned;
}

/** Take fuel from a floor zone. Finishes when the hopper is full; fails when the source is empty. */
function intake(state: MatchState, robot: RobotState, zone: FieldZoneId, dtS: number, events: EngineEvent[]): void {
  const p = robot.profile;
  if (p.capacity <= 0 || p.intakeRatePerS <= 0) return finish(state, robot, events, "cannot_collect");
  if (robot.fuelHeld >= p.capacity) return finish(state, robot, events);
  if (state.fuel.byZone[zone] <= 0) return finish(state, robot, events, "source_empty");
  robot.accum.intake += p.intakeRatePerS * dtS;
  const taken = Math.min(Math.floor(robot.accum.intake), state.fuel.byZone[zone], p.capacity - robot.fuelHeld);
  robot.accum.intake -= taken;
  robot.fuelHeld += taken;
  state.fuel.byZone[zone] -= taken;
  if (robot.fuelHeld >= p.capacity) {
    robot.accum.intake = 0;
    events.push({ kind: "hopper_full", timeS: state.timeS, robotId: robot.id });
    finish(state, robot, events);
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

function advanceRobot(state: MatchState, robot: RobotState, dtS: number, rng: Rng, events: EngineEvent[]): void {
  const step = currentStep(robot);
  if (!step) {
    brake(state, robot, dtS);
    return;
  }
  const physics = state.rules.physics;
  const follows = step.action === "defend" || step.action === "screen" || step.action === "protect_climber";

  // Navigation target: fixed at step start, except when following another robot.
  let arrived = true;
  if (robot.navTarget === null || follows) {
    const target = resolveTarget(state, robot, step);
    if (target === null) return finish(state, robot, events, "bad_target");
    robot.navTarget = target === undefined ? null : follows ? target : snapTarget(getGrid(state.field, physics), target, robot.profile.fitsUnderTrench);
  }
  if (robot.navTarget !== null) {
    const route = step.action === "route_via" ? step.params.route : step.action === "shoot_on_move" && "path" in step.params ? step.params.path : null;
    const goal = route ? crossingWaypoint(state, robot, route, robot.navTarget) : robot.navTarget;
    const before = { x: robot.pose.x, y: robot.pose.y };
    arrived = moveToward(state, robot, goal, dtS, follows ? physics.robotRadiusM * 2 + physics.arriveToleranceM : physics.arriveToleranceM, follows);
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
      if (step.params.source === "depot" ? arrived : here === zone) intake(state, robot, zone, dtS, events);
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
      fire(state, robot, robot.alignment.aligned ? 1 : state.rules.shotModel.dumpUnalignedAccuracyFactor, dtS, rng, events);
      break;
    case "dump_unaligned":
      fire(state, robot, state.rules.shotModel.dumpUnalignedAccuracyFactor, dtS, rng, events);
      break;
    case "align_then_shoot":
      if (align(robot, dtS)) fire(state, robot, 1, dtS, rng, events);
      break;
    case "hold_fire_until_active":
      if (robot.fuelHeld <= 0) finish(state, robot, events, "no_fuel");
      else if (state.hubs[robot.alliance].active && align(robot, dtS)) fire(state, robot, 1, dtS, rng, events);
      break;
    case "shoot_on_move": {
      if (!robot.profile.shootOnMove) return finish(state, robot, events, "cannot_shoot_on_move");
      const speed = Math.hypot(robot.velocity.vx, robot.velocity.vy);
      const table = robot.profile.sotmAccuracyBySpeed.map((row) => ({ x: row.speedMps, y: row.accuracy }));
      fire(state, robot, interpTable(table, speed), dtS, rng, events);
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

/**
 * Robots are solid discs: push overlapping pairs apart, the lighter robot moving more, then slide
 * both out of any field element. Pairs are processed in fixed state order.
 */
function separateRobots(state: MatchState): void {
  const robots = state.robots;
  const touch = state.rules.physics.robotRadiusM * 2;
  const grid = getGrid(state.field, state.rules.physics);
  for (let i = 0; i < robots.length; i++) {
    const a = robots[i]!;
    if (a.climb.level > 0 || a.climb.inProgress) continue;
    for (let j = i + 1; j < robots.length; j++) {
      const b = robots[j]!;
      if (b.climb.level > 0 || b.climb.inProgress) continue;
      const dx = b.pose.x - a.pose.x;
      const dy = b.pose.y - a.pose.y;
      const d = Math.hypot(dx, dy);
      if (d >= touch) continue;
      const ux = d > EPS ? dx / d : 1;
      const uy = d > EPS ? dy / d : 0;
      const overlap = touch - d;
      const ma = loadedMassKg(a.profile, a.fuelHeld);
      const mb = loadedMassKg(b.profile, b.fuelHeld);
      const shareA = mb / (ma + mb);
      a.pose.x -= ux * overlap * shareA;
      a.pose.y -= uy * overlap * shareA;
      b.pose.x += ux * overlap * (1 - shareA);
      b.pose.y += uy * overlap * (1 - shareA);
      resolvePosition(grid, a.pose, a.profile.fitsUnderTrench);
      resolvePosition(grid, b.pose, b.profile.fitsUnderTrench);
    }
  }
}

function pairKey(a: RobotState, b: RobotState): string {
  return `${a.id}|${b.id}`;
}

function opponentsInRange(state: MatchState): Set<string> {
  const near = new Set<string>();
  const range = state.rules.triggers.opponentInRangeM;
  for (const a of state.robots) {
    for (const b of state.robots) {
      if (a.alliance !== b.alliance && a.id < b.id && dist(a.pose, b.pose) <= range) near.add(pairKey(a, b));
    }
  }
  return near;
}

function updateContacts(state: MatchState, dtS: number, wasNear: Set<string>, events: EngineEvent[]): void {
  const t = state.timeS;
  const touchM = state.rules.physics.robotRadiusM * 2 + (state.rules.physics.contactMarginM ?? 0);
  const longS = state.rules.triggers.contactLongS;

  for (const robot of state.robots) {
    const other = state.robots.find((o) => o.id !== robot.id && dist(robot.pose, o.pose) <= touchM);
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
  for (const a of state.robots) {
    for (const b of state.robots) {
      if (a.alliance === b.alliance || a.id >= b.id) continue;
      const key = pairKey(a, b);
      if (nowNear.has(key) && !wasNear.has(key)) {
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
  for (const robot of state.robots) advanceRobot(state, robot, dtS, rng, events);
  separateRobots(state);
  advanceClock(state, dtS, rng, events);
  updateContacts(state, dtS, wasNear, events);
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
  let askAgain = new Set<RobotId>();

  while (state.timeS < endS - EPS && state.phase !== "finished") {
    for (const robot of state.robots) {
      if (pending[robot.id] !== undefined) continue;
      if (overridden.has(robot.id)) {
        if (robot.intent !== null) continue; // override still running
        overridden.delete(robot.id);
      }
      if (robot.intent === null || askAgain.has(robot.id)) {
        const policy = policies.byRobot?.[robot.id] ?? policies.default;
        pending[robot.id] = policy.decide(buildObservationView(state, robot.id));
      }
    }
    const { events } = step(state, pending, dtS);
    pending = {};
    askAgain = new Set(events.filter((e) => e.kind === "watchdog").map((e) => e.robotId));
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
