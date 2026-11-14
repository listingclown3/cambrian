import { describe, expect, it } from "vitest";
import { EngineEventSchema, MatchStateSchema, RolloutResultSchema, SnapshotSchema, type EngineEvent } from "../contracts";
import { MatchRunner, basicCyclePolicy, demoRobots, holdPolicy } from "../exec";
import { loadConfig } from "../util/config";
import { engine } from "./index";

const cfg = loadConfig();
const policies = { default: basicCyclePolicy };
const newRunner = (seed: number) => new MatchRunner(engine, cfg, seed, demoRobots(cfg), policies);

describe("stub engine: contract", () => {
  it("createMatch returns a schema-valid state with preloaded robots", () => {
    const state = engine.createMatch(cfg, 7, demoRobots(cfg));
    expect(() => MatchStateSchema.parse(state)).not.toThrow();
    expect(state.robots.map((r) => r.id)).toEqual(["B1", "B2", "B3", "R1", "R2", "R3"]);
    for (const robot of state.robots) expect(robot.fuelHeld).toBe(Math.min(cfg.game.maxPreloadFuel.value, robot.profile.capacity));
    expect(state.hubs.red.active && state.hubs.blue.active).toBe(true);
  });

  it("plays a full match with valid states and events", () => {
    const runner = newRunner(1001);
    const events: EngineEvent[] = [];
    const activeByPhase = new Map<string, Set<string>>();
    while (!runner.finished) {
      const tick = runner.tick();
      events.push(...tick.events);
      const key = `${tick.state.phase}${tick.state.shiftIndex || ""}`;
      const seen = activeByPhase.get(key) ?? new Set<string>();
      seen.add(`${tick.state.hubs.blue.active ? "B" : "-"}${tick.state.hubs.red.active ? "R" : "-"}`);
      activeByPhase.set(key, seen);
    }
    const state = runner.state;
    expect(state.timeS).toBeCloseTo(cfg.game.autoS.value + cfg.game.teleopS.value, 6);
    expect(() => MatchStateSchema.parse(state)).not.toThrow();
    for (const e of events) expect(EngineEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);

    // hubs: both active in auto, transition and endgame; exactly one active in each shift, alternating
    for (const phase of ["auto", "transition", "endgame"]) expect([...activeByPhase.get(phase)!], phase).toEqual(["BR"]);
    const shifts = [1, 2, 3, 4].map((i) => [...activeByPhase.get(`shift${i}`)!]);
    for (const s of shifts) expect(s).toHaveLength(1);
    expect(shifts[0]).toEqual(shifts[2]);
    expect(shifts[1]).toEqual(shifts[3]);
    expect(shifts[0]).not.toEqual(shifts[1]);
    expect(["B-", "-R"]).toContain(shifts[0]![0]);

    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of ["action_done", "hub_shift", "hub_warning", "endgame_start", "score", "hopper_full", "hopper_empty"]) {
      expect(kinds.has(kind as EngineEvent["kind"]), kind).toBe(true);
    }
    expect(state.score.red.total + state.score.blue.total).toBeGreaterThan(0);
    const fuelOnField = Object.values(state.fuel.byZone).reduce((a, b) => a + b, 0) + state.fuel.piles.reduce((a, p) => a + p.count, 0);
    const fuelInRobots = state.robots.reduce((a, r) => a + r.fuelHeld, 0);
    const start = cfg.game.fuelStart.value;
    const preloaded = demoRobots(cfg).reduce((a, r) => a + Math.min(cfg.game.maxPreloadFuel.value, r.profile.capacity), 0);
    expect(fuelOnField + fuelInRobots).toBe(start.neutral + 2 * start.depotEach + 2 * start.outpostEach + preloaded); // fuel is conserved
  });

  it("is deterministic for a seed", () => {
    const a = newRunner(42).runToEnd().state;
    const b = newRunner(42).runToEnd().state;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("step() on a finished match is a no-op", () => {
    const state = newRunner(3).runToEnd().state;
    const before = JSON.stringify(state);
    expect(engine.step(state, {}, 0.05).events).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("stub engine: snapshot, restore, rollout", () => {
  it("restore(snapshot) continues exactly like the original, even after a JSON round trip", () => {
    const runner = newRunner(1002);
    for (let i = 0; i < 700; i++) runner.tick();
    const snap = engine.snapshot(runner.state);
    const viaJson = SnapshotSchema.parse(JSON.parse(JSON.stringify(snap)));

    const play = (state: ReturnType<typeof engine.restore>) => {
      for (let i = 0; i < 400; i++) {
        const intents = Object.fromEntries(state.robots.filter((r) => r.intent === null).map((r) => [r.id, { action: "collect", params: { source: "neutral" } } as const]));
        engine.step(state, intents, state.rules.physics.dtS);
      }
      return JSON.stringify(state);
    };
    const a = play(engine.restore(snap));
    const b = play(engine.restore(viaJson));
    expect(a).toBe(b);
    expect(JSON.stringify(engine.snapshot(runner.state))).toBe(JSON.stringify(snap)); // the original was not disturbed
  });

  it("rollout returns a valid result, leaves the snapshot alone, and is deterministic per seed", () => {
    const runner = newRunner(1003);
    for (let i = 0; i < 600; i++) runner.tick();
    const snap = engine.snapshot(runner.state);
    const frozen = JSON.stringify(snap);
    const override = { B1: { action: "goto_zone", params: { zone: "neutral" } } as const };

    const r1 = engine.rollout(snap, override, cfg.answerKey.horizonS, 5, policies);
    const r2 = engine.rollout(snap, override, cfg.answerKey.horizonS, 5, policies);
    expect(() => RolloutResultSchema.parse(r1)).not.toThrow();
    expect(JSON.stringify(snap)).toBe(frozen);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.finalSnapshot.takenAtS).toBeCloseTo(snap.takenAtS + cfg.answerKey.horizonS, 6);
    expect(r1.pointsFor).toBeGreaterThanOrEqual(0);

    // perspective flips For/Against
    const asRed = engine.rollout(snap, override, 5, 5, policies, { perspective: "red" });
    const asBlue = engine.rollout(snap, override, 5, 5, policies, { perspective: "blue" });
    expect(asRed.pointsFor).toBe(asBlue.pointsAgainst);
    expect(asRed.pointsAgainst).toBe(asBlue.pointsFor);
  });

  it("rollout overrides change the outcome", () => {
    const runner = newRunner(1004);
    for (let i = 0; i < 500; i++) runner.tick();
    const snap = engine.snapshot(runner.state);
    const everyoneHolds = Object.fromEntries(snap.state.robots.map((r) => [r.id, { action: "hold_position", params: {} } as const]));
    const idle = engine.rollout(snap, everyoneHolds, 20, 9, { default: holdPolicy }, { perspective: "blue" });
    const active = engine.rollout(snap, {}, 20, 9, policies, { perspective: "blue" });
    expect(idle.pointsFor + idle.pointsAgainst).toBe(0);
    expect(active.pointsFor + active.pointsAgainst).toBeGreaterThan(0);
  });
});
