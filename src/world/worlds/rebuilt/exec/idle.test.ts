import { describe, expect, it } from "vitest";
import { profileFromTemplate, type Archetype, type MatchRobotSpec } from "../../../../contracts";
import { buildObservationView, engine } from "../engine";
import { loadConfig } from "../../../../util/config";
import { demoRobots } from "./demoMatch";
import { measureIdle } from "./idle";
import { MatchRunner } from "./matchRunner";
import { archetypePolicy, roleContinuation } from "./policies";

const cfg = loadConfig();
const MAX_IDLE_S = cfg.triggers.maxIdleS ?? 1;

/** A second line-up with the archetypes the demo line-up lacks (defender, zero-hopper, starter). */
function otherLineup(): MatchRobotSpec[] {
  const make = (archetype: Archetype, alliance: "blue" | "red", n: number): MatchRobotSpec => ({
    profile: profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id: `t_${alliance}_${n}`, teamLabel: `T ${alliance} ${n}` }, cfg.game.fuelMassKg.value),
    alliance,
    controllerId: "archetype",
  });
  return [
    make("defender", "blue", 1),
    make("zero_hopper_turret", "blue", 2),
    make("starter_bot", "blue", 3),
    make("drum_fixed", "red", 1),
    make("turret_sotm", "red", 2),
    make("big_hopper_hauler", "red", 3),
  ];
}

describe("no-idle rule", () => {
  it(`no robot stands still without an active intent for more than maxIdleS over 20 seeded matches`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const robots = seed % 2 === 0 ? demoRobots(cfg) : otherLineup();
      for (const r of measureIdle(cfg, 500 + seed, robots, archetypePolicy)) {
        expect(r.longestIdleS, `seed ${500 + seed} ${r.robotId} (${r.archetype})`).toBeLessThanOrEqual(MAX_IDLE_S);
      }
    }
  }, 600_000);

  it("roleContinuation only returns intents built from the view's options", () => {
    const runner = new MatchRunner(engine, cfg, 77, otherLineup(), { default: archetypePolicy });
    let checked = 0;
    while (!runner.finished && runner.state.timeS < 60) {
      runner.tick();
      if (runner.state.tick % 20 !== 0) continue;
      for (const robot of runner.state.robots) {
        const view = buildObservationView(runner.state, robot.id);
        const intent = roleContinuation(view);
        const { then, ...first } = intent;
        const labels = view.options.map((o) => JSON.stringify(o.intent));
        expect(labels, JSON.stringify(intent)).toContain(JSON.stringify(first));
        if (then) expect(view.options.some((o) => o.intent.action === then.action)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
