import { describe, expect, it } from "vitest";
import { ci95, loadMyRobot, mean, playOne } from "./benchMyRobot";
import { loadConfig } from "../../../src/util/config";

describe("benchMyRobot", () => {
  it("mean and ci95", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(ci95([5])).toBeNull();
    expect(ci95([1, 3])).toBeCloseTo((1.96 * Math.SQRT2) / Math.SQRT2, 6);
  });
  it("loads my_robot.json without the _note field", () => {
    expect(loadMyRobot().id).toBe("my_robot");
  });
  it("scripted match is deterministic and offline", async () => {
    const cfg = loadConfig();
    const mine = loadMyRobot();
    const a = await playOne(cfg, mine, "defender", cfg.seeds.eval[0]!, "scripted");
    const b = await playOne(cfg, mine, "defender", cfg.seeds.eval[0]!, "scripted");
    expect(a.m).toEqual(b.m);
  }, 180000);
});
