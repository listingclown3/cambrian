import { describe, expect, it } from "vitest";
import { MatchStateSchema, SnapshotSchema, type EngineEvent, type MatchState } from "../../../../contracts";
import { MatchRunner, basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../../../../util/config";
import { rebuiltEngine as engine } from "./engine";
import { blockedAt, clearNavCaches, getGrid, inTrench } from "./nav";
import { buildObservationView } from "./observe";

const cfg = loadConfig();
const policies = { default: basicCyclePolicy };
const newRunner = (seed: number) => new MatchRunner(engine, cfg, seed, demoRobots(cfg), policies);
/** Per-test timeout for full matches: the machine may be busy with other work. */
const SLOW = 120_000;

function totalFuel(state: MatchState): number {
  const onField = Object.values(state.fuel.byZone).reduce((a, b) => a + b, 0) + state.fuel.piles.reduce((a, p) => a + p.count, 0);
  const inFlight = state.fuel.balls.length;
  const held = state.robots.reduce((a, r) => a + r.fuelHeld, 0);
  return onField + inFlight + held;
}

describe("rebuilt engine", () => {
  it("is bit-identical for the same seed (states and events)", () => {
    const run = (seed: number) => {
      const runner = newRunner(seed);
      const events: EngineEvent[] = [];
      while (!runner.finished) events.push(...runner.tick().events);
      return JSON.stringify(runner.state) + JSON.stringify(events);
    };
    expect(run(77)).toBe(run(77));
    expect(run(77)).not.toBe(run(78));
  }, SLOW);

  it("does not depend on navigation cache state (warm vs cold caches give the same match)", () => {
    const run = () => JSON.stringify(newRunner(91).runToEnd().state);
    clearNavCaches();
    const cold = run();
    newRunner(92).runToEnd(); // warm the caches with other paths
    const warm = run();
    expect(warm).toBe(cold);
  }, SLOW);

  it("snapshot/restore is exact after a JSON round trip", () => {
    const runner = newRunner(1005);
    for (let i = 0; i < 900; i++) runner.tick();
    const snap = engine.snapshot(runner.state);
    const viaJson = SnapshotSchema.parse(JSON.parse(JSON.stringify(snap)));
    const a = engine.restore(snap);
    const b = engine.restore(viaJson);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const play = (state: MatchState) => {
      const out: EngineEvent[] = [];
      for (let i = 0; i < 600; i++) {
        const intents = Object.fromEntries(
          state.robots.filter((r) => r.intent === null).map((r) => [r.id, basicCyclePolicy.decide(buildObservationView(state, r.id))]),
        );
        out.push(...engine.step(state, intents, state.rules.physics.dtS).events);
      }
      return JSON.stringify(state) + JSON.stringify(out);
    };
    expect(play(a)).toBe(play(b));
  }, SLOW);

  it("conserves fuel over a full match and keeps every state valid", () => {
    const runner = newRunner(1006);
    const start = totalFuel(runner.state);
    while (!runner.finished) {
      runner.tick(); // scored fuel returns to the field, so the total never changes
      expect(totalFuel(runner.state)).toBe(start);
    }
    expect(() => MatchStateSchema.parse(runner.state)).not.toThrow();
    expect(runner.state.score.blue.total + runner.state.score.red.total).toBeGreaterThan(0);
  }, SLOW);

  it("fuel scores only while the hub is active, and the warning comes before each deactivation", () => {
    const runner = newRunner(1007);
    let warned: Record<string, boolean> = { red: false, blue: false };
    const prevActive = { red: true, blue: true };
    while (!runner.finished) {
      const before = { red: runner.state.hubs.red.active, blue: runner.state.hubs.blue.active };
      const { events, state } = runner.tick();
      for (const e of events) {
        if (e.kind === "hub_warning") warned[e.alliance] = true;
        if (e.kind === "score" && e.source === "fuel" && e.points > 0) expect(before[e.alliance] || state.hubs[e.alliance].active).toBe(true);
      }
      for (const a of ["red", "blue"] as const) {
        if (prevActive[a] && !state.hubs[a].active && state.phase === "shift") {
          expect(warned[a], `warning before ${a} deactivates at ${state.timeS}`).toBe(true);
          warned = { ...warned, [a]: false };
        }
        prevActive[a] = state.hubs[a].active;
      }
    }
  }, SLOW);

  it("robots never overlap a field element, and tall robots never enter a trench", () => {
    const runner = newRunner(1008);
    const grid = getGrid(runner.state.field, runner.state.rules.physics);
    let crossings = 0;
    const side = new Map<string, string>();
    while (!runner.finished) {
      const { state } = runner.tick();
      for (const r of state.robots) {
        expect(blockedAt(grid, r.pose, r.profile.fitsUnderTrench), `${r.id} at ${r.pose.x},${r.pose.y}`).toBe(false);
        if (!r.profile.fitsUnderTrench) expect(inTrench(grid, r.pose)).toBe(false);
        const zone = r.pose.x < state.field.lengthM / 2 ? "blue_half" : "red_half";
        if (side.get(r.id) && side.get(r.id) !== zone) crossings++;
        side.set(r.id, zone);
      }
    }
    expect(crossings).toBeGreaterThan(0);
  }, SLOW);

  it("robots reach the neutral zone through a crossing (not through the hub)", () => {
    const state = engine.createMatch(cfg, 3, demoRobots(cfg));
    const intents = Object.fromEntries(state.robots.map((r) => [r.id, { action: "goto_zone", params: { zone: "neutral" } } as const]));
    engine.step(state, intents, state.rules.physics.dtS);
    for (let i = 0; i < 400; i++) engine.step(state, {}, state.rules.physics.dtS);
    for (const r of state.robots) {
      expect(r.pose.x).toBeGreaterThan(state.field.neutral.x0);
      expect(r.pose.x).toBeLessThan(state.field.neutral.x1);
    }
  });
});

