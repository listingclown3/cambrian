import { describe, expect, it } from "vitest";
import { loadConfig } from "../util/config";
import { rebuiltWorld } from "./worlds/rebuilt/adapter";

describe("REBUILT world adapter", () => {
  const world = rebuiltWorld(loadConfig());

  it("declares itself a reality world that flags rule breaks by default", () => {
    expect(world.tier).toBe("reality");
    expect(world.defaultRulesMode).toBe("flag");
    expect(world.versionHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("plays deterministic seeded episodes and reports every declared metric", () => {
    const a = world.runEpisode(1001, { blue: "basic_cycle", red: "basic_cycle" });
    const b = world.runEpisode(1001, { blue: "basic_cycle", red: "basic_cycle" });
    expect(a).toEqual(b);
    expect(Object.keys(a.metrics).sort()).toEqual(world.metrics.map((m) => m.id).sort());
    // same numbers as `pnpm match -- --seed 1001 --policy basic_cycle` (blue 241, red 290)
    expect(a.metrics.margin).toBe(241 - 290);
  });

  it("rejects unknown policies", () => {
    expect(() => world.runEpisode(1001, { blue: "nope", red: "basic_cycle" })).toThrow(/unknown REBUILT policy/);
  });
});
