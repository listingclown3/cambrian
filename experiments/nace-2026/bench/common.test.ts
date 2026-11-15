import { describe, expect, it } from "vitest";
import { engine } from "../../../src/world/worlds/rebuilt/engine";
import { demoRobots } from "../../../src/world/worlds/rebuilt/exec";
import { loadConfig } from "../../../src/util/config";
import { anonymize, ci95, curateOptions, mean } from "./common";

describe("bench common helpers", () => {
  it("computes a Student-t 95% half-width", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(ci95([5])).toBe(0);
    // sd = 1, n = 3, t(2) = 4.303 -> 4.303 / sqrt(3)
    expect(ci95([1, 2, 3])).toBeCloseTo(4.303 / Math.sqrt(3), 6);
  });

  it("anonymizes labels but keeps descriptions and maps back", () => {
    const req = { stateText: "s", seed: 1, mode: "offline" as const, questions: [{ id: "next_action", kind: "choice" as const, instructions: "i", options: [{ label: "a", description: "A" }, { label: "b", description: "B" }] }] };
    const { request, toReal } = anonymize(req);
    expect(request.questions[0]!.options!.map((o) => o.label)).toEqual(["opt_01", "opt_02"]);
    expect(request.questions[0]!.options!.map((o) => o.description)).toEqual(["A", "B"]);
    expect(toReal.get("opt_02")).toBe("b");
    expect(request.stateText).toBe(req.stateText);
  });

  it("curates between 2 and 10 distinct options by a fixed rule", () => {
    const cfg = loadConfig();
    const state = engine.createMatch(cfg, 1, demoRobots(cfg));
    for (const r of state.robots) {
      const opts = curateOptions(state, r.id);
      expect(opts.length).toBeGreaterThanOrEqual(2);
      expect(opts.length).toBeLessThanOrEqual(10);
      expect(new Set(opts.map((o) => o.label)).size).toBe(opts.length);
      expect(curateOptions(state, r.id).map((o) => o.label)).toEqual(opts.map((o) => o.label));
    }
  });
});
