import { describe, expect, it } from "vitest";
import { loadConfig } from "../util/config";
import { judgeLegality, tagLegality } from "./quirks";
import { compareTowerPostUp, findPostUpSpots } from "./towerPostUp";

describe("tagLegality", () => {
  it("tags by thresholds", () => {
    expect(tagLegality([0.1, 0.29], 0.1)).toBe("LEGAL");
    expect(tagLegality([0.1, 0.5], 0.1)).toBe("RISKY");
    expect(tagLegality([0.1], 0.4)).toBe("RISKY");
    expect(tagLegality([0.9, 0.1], 0)).toBe("ILLEGAL");
    expect(tagLegality([null], null)).toBe("LEGAL");
  });
});

describe("judgeLegality with a fake judge", () => {
  const cfg = loadConfig();
  const rules = [{ id: "G418", topic: "t", page: 72, text: "x" }, { id: "G210", topic: "t", page: 59, text: "y" }];
  it("maps answers per rule and records errors as nulls", async () => {
    const ok = (async (_c: unknown, a: { questions: Record<string, unknown> }) => ({
      answers: Object.fromEntries(Object.keys(a.questions).map((k) => [k, { noul: k === "violates__G418" ? 0.8 : 0.1 }])),
      model: "fake", latencyMs: 0, inputTokens: 0,
    })) as never;
    const r = await judgeLegality(cfg, [{ id: "a", description: "d" }], rules, ok);
    expect(r.out.a!.rules).toEqual([{ id: "G418", page: 72, pViolation: 0.8 }, { id: "G210", page: 59, pViolation: 0.1 }]);
    expect(r.out.a!.reliesOnOpponentFouls).toBe(0.1);
    const bad = (async () => { throw new Error("Drex http 403"); }) as never;
    const e = await judgeLegality(cfg, [{ id: "a", description: "d" }], rules, bad);
    expect(e.errors.a).toContain("403");
    expect(e.out.a!.rules[0]!.pViolation).toBeNull();
  });
});

describe("tower post-up", () => {
  it("reports not run when the config has no post-up spot", () => {
    const cfg = loadConfig();
    if (findPostUpSpots(cfg).length === 0) expect(compareTowerPostUp(cfg).run).toBe(false);
  });
});
