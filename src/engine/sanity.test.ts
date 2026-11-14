/**
 * Sanity ladder for the engine: simple "this must obviously be true" comparisons.
 * Each uses several seeds so one lucky match cannot pass or fail it.
 */
import { describe, expect, it } from "vitest";
import { profileFromTemplate, type Archetype, type EngineEvent, type MatchRobotSpec, type RobotProfile, type RolloutPolicies } from "../contracts";
import { planManeuver } from "../exec/maneuver";
import { MatchRunner } from "../exec/matchRunner";
import { archetypePolicy, holdPolicy } from "../exec/policies";
import { runRolloutBatch } from "../exec/rolloutWorker";
import { loadConfig } from "../util/config";
import { rebuiltEngine as engine } from "./engine";
import { getGrid, inTrench } from "./nav";

const cfg = loadConfig();
const SEEDS = [11, 12, 13];
/** Match seconds each comparison plays (auto, the transition and the first shifts): keeps the suite fast. */
const PLAY_S = 60;
/** Per-test timeout: these play several partial matches and the machine may be busy. */
const SLOW = 120_000;

function profile(archetype: Archetype, id: string, patch: Partial<RobotProfile> = {}): RobotProfile {
  const p = profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id, teamLabel: id }, cfg.game.fuelMassKg.value);
  return { ...p, ...patch };
}

function spec(p: RobotProfile, alliance: "red" | "blue"): MatchRobotSpec {
  return { profile: p, alliance, controllerId: "test" };
}

function play(robots: MatchRobotSpec[], seed: number, policies: RolloutPolicies = { default: archetypePolicy }) {
  const runner = new MatchRunner(engine, cfg, seed, robots, policies);
  const events: EngineEvent[] = [];
  while (!runner.finished && runner.state.timeS < PLAY_S) events.push(...runner.tick().events);
  return { state: runner.state, events };
}

const fuelPoints = (s: { autoFuel: number; teleopFuel: number }) => s.autoFuel + s.teleopFuel;

describe("sanity ladder", () => {
  it("a more accurate shooter outscores a less accurate one", () => {
    const good = profile("drum_fixed", "good");
    const bad = { ...good, id: "bad", teamLabel: "bad", shotAccuracyByDistance: good.shotAccuracyByDistance.map((r) => ({ ...r, accuracy: r.accuracy * 0.5 })) };
    let blue = 0;
    let red = 0;
    for (const seed of SEEDS) {
      const { state } = play([spec(good, "blue"), spec(bad, "red")], seed);
      blue += fuelPoints(state.score.blue);
      red += fuelPoints(state.score.red);
    }
    expect(blue).toBeGreaterThan(red);
  }, SLOW);

  it("a faster-firing shooter outscores a slower one", () => {
    const fast = profile("multilane_fixed", "fast", { fireRatePerS: 8 });
    const slow = { ...fast, id: "slow", teamLabel: "slow", fireRatePerS: 2 };
    let blue = 0;
    let red = 0;
    for (const seed of SEEDS) {
      const { state } = play([spec(fast, "blue"), spec(slow, "red")], seed);
      blue += fuelPoints(state.score.blue);
      red += fuelPoints(state.score.red);
    }
    expect(blue).toBeGreaterThan(red);
  }, SLOW);

  it("a defended shooter scores less than an undefended one", () => {
    const shooter = profile("drum_fixed", "shooter");
    const defender = profile("defender", "defender");
    let defended = 0;
    let free = 0;
    for (const seed of SEEDS) {
      const robots = [spec(shooter, "blue"), spec(defender, "red")];
      defended += fuelPoints(play(robots, seed).state.score.blue);
      free += fuelPoints(play(robots, seed, { default: archetypePolicy, byRobot: { R1: holdPolicy } }).state.score.blue);
    }
    expect(defended).toBeLessThan(free);
  }, SLOW);

  it("a robot that does not fit under the trench never enters one, and refuses trench routes", () => {
    const tall = profile("big_hopper_hauler", "tall", { fitsUnderTrench: false });
    const state = engine.createMatch(cfg, 5, [spec(tall, "blue")]);
    const { events } = engine.step(state, { B1: { action: "route_via", params: { route: "left_trench" } } }, state.rules.physics.dtS);
    expect(events.some((e) => e.kind === "action_failed" && e.reason === "cannot_fit")).toBe(true);

    const grid = getGrid(state.field, state.rules.physics);
    for (const seed of SEEDS) {
      const runner = new MatchRunner(engine, cfg, seed, [spec(tall, "blue"), spec(tall, "red")], { default: archetypePolicy });
      let crossed = false;
      while (!runner.finished && runner.state.timeS < PLAY_S) {
        runner.tick();
        for (const r of runner.state.robots) {
          expect(inTrench(grid, r.pose)).toBe(false);
          if (r.pose.x > runner.state.field.neutral.x0 && r.pose.x < runner.state.field.neutral.x1) crossed = true;
        }
      }
      expect(crossed).toBe(true); // it still gets to the neutral zone, over a bump
    }
  }, SLOW);

  it("a robot pinned by an opponent for longer than the limit draws a G418 foul", () => {
    const victim = profile("drum_fixed", "victim");
    const bully = profile("defender", "bully");
    const state = engine.createMatch(cfg, 21, [spec(victim, "blue"), spec(bully, "red")]);
    const dtS = state.rules.physics.dtS;
    const r = state.rules.physics.robotRadiusM;
    // Victim against the side wall in the neutral zone, the stronger defender right on top of it.
    const x = (state.field.neutral.x0 + state.field.neutral.x1) / 2;
    Object.assign(state.robots[0]!.pose, { x, y: r });
    Object.assign(state.robots[1]!.pose, { x, y: 3 * r });
    // Both drive into each other (blue's left wall is +y, red's left wall is -y).
    const victimPush = { action: "push_through", params: { direction: "toward_left_wall" } } as const;
    const events: EngineEvent[] = [...engine.step(state, { B1: victimPush, R1: { action: "push_through", params: { direction: "toward_left_wall" } } }, dtS).events];
    for (let i = 0; i < 200 && !events.some((e) => e.kind === "foul"); i++) events.push(...engine.step(state, {}, dtS).events);
    const foul = events.find((e): e is Extract<EngineEvent, { kind: "foul" }> => e.kind === "foul");
    expect(foul).toBeDefined();
    expect(foul?.clauseId).toBe(cfg.game.pinning.value.clauseId);
    expect(foul?.robotId).toBe("R1");
    expect(foul?.timeS).toBeGreaterThanOrEqual(cfg.game.pinning.value.limitS);
    expect(events.some((e) => e.kind === "pinned" && e.robotId === "B1")).toBe(true);
    expect(state.score.blue.foulPoints).toBe(cfg.game.minorFoulPoints.value);
  });

  it("the maneuver planner picks spin or reverse by micro-rollouts, deterministically", () => {
    const victim = profile("drum_fixed", "victim");
    const bully = profile("defender", "bully");
    const state = engine.createMatch(cfg, 23, [spec(victim, "blue"), spec(bully, "red")]);
    const dtS = state.rules.physics.dtS;
    engine.step(state, { B1: { action: "goto_zone", params: { zone: "neutral" } } }, dtS);
    for (let i = 0; i < 200 && state.robots[0]!.intent !== null; i++) engine.step(state, {}, dtS);
    engine.step(state, { B1: { action: "goto_zone", params: { zone: "our_alliance" } }, R1: { action: "defend", params: { robotId: "B1" } } }, dtS);
    for (let i = 0; i < 300 && state.robots[0]!.contact.withRobotId !== "R1"; i++) engine.step(state, {}, dtS);
    const ask = { action: "escape_spin", params: { exitToward: "our_alliance" } } as const;
    const settings = { count: cfg.microRollouts.count, horizonS: cfg.microRollouts.horizonS };
    const policies = { default: archetypePolicy };
    const a = planManeuver(engine, state, "B1", ask, settings, policies);
    const b = planManeuver(engine, state, "B1", ask, settings, policies);
    expect(a.scores.map((x) => x.label)).toEqual(["escape_spin:our_alliance", "escape_reverse:our_alliance"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(["escape_spin", "escape_reverse"]).toContain(a.intent.action);
    for (const x of a.scores) expect(Number.isFinite(x.meanMargin) && Number.isFinite(x.meanExitDistanceM)).toBe(true);
  }, SLOW);

  describe("G420 tower protection", () => {
    // B1 posts up against its own tower; R1 then drives into it (defend B1).
    function setup(seed: number) {
      const state = engine.createMatch(cfg, seed, [spec(profile("drum_fixed", "poster"), "blue"), spec(profile("defender", "contester"), "red")]);
      const dtS = state.rules.physics.dtS;
      engine.step(state, { B1: { action: "goto_shot_spot", params: { spotId: "tower_post_right" } }, R1: { action: "hold_position", params: {} } }, dtS);
      for (let i = 0; i < 200 && state.robots[0]!.intent !== null; i++) engine.step(state, {}, dtS);
      engine.step(state, { B1: { action: "hold_position", params: {} } }, dtS);
      return state;
    }
    function contest(state: ReturnType<typeof setup>): EngineEvent[] {
      const events: EngineEvent[] = [...engine.step(state, { R1: { action: "defend", params: { robotId: "B1" } } }, state.rules.physics.dtS).events];
      for (let i = 0; i < 300 && state.robots[1]!.contact.withRobotId !== "B1"; i++) events.push(...engine.step(state, {}, state.rules.physics.dtS).events);
      for (let i = 0; i < 10; i++) events.push(...engine.step(state, {}, state.rules.physics.dtS).events);
      expect(state.robots[1]!.contact.withRobotId).toBe("B1");
      return events;
    }
    const g420 = (events: EngineEvent[]) => events.filter((e): e is Extract<EngineEvent, { kind: "foul" }> => e.kind === "foul" && e.clauseId === "G420");

    it("contact with an opponent touching its tower in the last 30 s is one major foul", () => {
      const state = setup(51);
      state.timeS = state.rules.matchS - 25; // jump the clock into the final 30 seconds
      const fouls = g420(contest(state));
      expect(fouls).toHaveLength(1);
      expect(fouls[0]!.robotId).toBe("R1");
      expect(fouls[0]!.severity).toBe("major");
      expect(state.score.blue.foulPoints).toBe(cfg.game.majorFoulPoints.value);
      expect(state.score.blue.teleopTower).toBe(0); // on the ground: no tower award
    });

    it("an opponent that is off the ground is also awarded level 3 tower points", () => {
      const state = setup(52);
      state.timeS = state.rules.matchS - 25;
      engine.step(state, { B1: { action: "climb", params: { level: 1 } } }, state.rules.physics.dtS);
      const events = contest(state);
      expect(g420(events)).toHaveLength(1);
      expect(state.score.blue.teleopTower).toBe(cfg.game.towerTeleopPoints.value[2]);
      expect(state.robots[0]!.climb.level).toBe(3);
    });

    it("the same contact earlier in the match is not a G420 foul", () => {
      const state = setup(53);
      expect(state.timeS).toBeLessThan(state.rules.matchS - 30);
      expect(g420(contest(state))).toHaveLength(0);
      expect(state.score.blue.foulPoints).toBe(0);
    });
  });

  it("a weak robot cannot shove a stronger one that holds its ground", () => {
    const weak = profile("starter_bot", "weak");
    const wall = profile("defender", "wall");
    const state = engine.createMatch(cfg, 22, [spec(weak, "blue"), spec(wall, "red")]);
    const dtS = state.rules.physics.dtS;
    engine.step(state, { B1: { action: "goto_zone", params: { zone: "neutral" } } }, dtS);
    for (let i = 0; i < 200 && state.robots[0]!.intent !== null; i++) engine.step(state, {}, dtS);
    engine.step(state, { B1: { action: "goto_zone", params: { zone: "our_alliance" } }, R1: { action: "defend", params: { robotId: "B1" } } }, dtS);
    // Wait until the defender is in the way, then the weak robot should make no headway.
    for (let i = 0; i < 300 && state.robots[0]!.contact.withRobotId !== "R1"; i++) engine.step(state, {}, dtS);
    expect(state.robots[0]!.contact.withRobotId).toBe("R1");
    for (let i = 0; i < 10; i++) engine.step(state, {}, dtS);
    const before = { ...state.robots[0]!.pose };
    for (let i = 0; i < 20; i++) engine.step(state, {}, dtS);
    const moved = Math.hypot(state.robots[0]!.pose.x - before.x, state.robots[0]!.pose.y - before.y);
    expect(moved).toBeLessThan(cfg.triggers.noProgressMinMoveM);
  });

  it("fuel shot at an inactive hub scores nothing", () => {
    const shooter = profile("drum_fixed", "s");
    const { state, events } = play([spec(shooter, "blue"), spec(shooter, "red")], 31);
    const scored = events.filter((e): e is Extract<EngineEvent, { kind: "score" }> => e.kind === "score" && e.source === "fuel");
    expect(scored.every((e) => e.points === cfg.game.fuelPointsActiveHub.value)).toBe(true);
    expect(fuelPoints(state.score.blue)).toBe(scored.filter((e) => e.alliance === "blue").length * cfg.game.fuelPointsActiveHub.value);
  });

  it("rollout batches (the worker pool's task) match Engine.rollout exactly", () => {
    const robots = [spec(profile("drum_fixed", "a"), "blue"), spec(profile("dumper", "b"), "red")];
    const runner = new MatchRunner(engine, cfg, 41, robots, { default: archetypePolicy });
    while (runner.state.timeS < 40) runner.tick();
    const snap = engine.snapshot(runner.state);
    const batch = runRolloutBatch({ snapshot: snap, overrides: {}, horizonS: 10, seeds: [1, 2], policies: { default: "archetype" }, options: { perspective: "blue" } });
    for (const r of batch) {
      const direct = engine.rollout(snap, {}, 10, r.seed, { default: archetypePolicy }, { perspective: "blue" });
      expect([r.pointsFor, r.pointsAgainst, r.foulsFor, r.foulsAgainst]).toEqual([direct.pointsFor, direct.pointsAgainst, direct.foulsFor, direct.foulsAgainst]);
    }
  });
});
