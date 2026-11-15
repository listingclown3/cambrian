import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QuirkNode } from "../contracts";
import { repoPath } from "../util/config";
import { QuirkArchive, satisfies } from "./graph";
import { seedRebuiltArchive } from "./seed";
import { isQuirk, surprise } from "./surprise";

const q = (id: string, start: QuirkNode["start"], end: QuirkNode["end"], effect: number | null = null): QuirkNode => ({
  id,
  title: id,
  level: "play",
  world: "w",
  source: "test",
  start,
  end,
  effect: { value: effect, ci95: null, n: 0, unit: "pts" },
  predicted: null,
  legality: "UNJUDGED",
  rules: [],
  reproducibility: { runs: 0, reproduced: 0 },
  value: 0,
  notes: "",
});

describe("conditions", () => {
  it("evaluates every operator and fails on missing keys", () => {
    const s = { x: 3, zone: "neutral", loaded: true };
    expect(satisfies(s, [{ key: "x", op: "gte", value: 3 }, { key: "x", op: "lt", value: 4 }])).toBe(true);
    expect(satisfies(s, [{ key: "zone", op: "in", value: ["neutral", "red"] }])).toBe(true);
    expect(satisfies(s, [{ key: "loaded", op: "eq", value: true }, { key: "zone", op: "ne", value: "blue" }])).toBe(true);
    expect(satisfies(s, [{ key: "missing", op: "ne", value: 1 }])).toBe(false);
    expect(satisfies(s, [{ key: "zone", op: "gt", value: 1 }])).toBe(false);
    expect(satisfies(s, [])).toBe(true);
  });
});

describe("quirk archive graph", () => {
  // a -> b -> c, and a -> c directly (skip link); d starts anywhere; e is unreachable from a
  const build = () =>
    new QuirkArchive("w", [
      q("a", [], { zone: "neutral", fuel: 8 }),
      q("b", [{ key: "zone", op: "eq", value: "neutral" }], { zone: "trench", fuel: 8 }),
      q("c", [{ key: "fuel", op: "gt", value: 4 }], { zone: "hub", fuel: 0 }),
      q("d", [], { zone: "depot" }),
      q("e", [{ key: "zone", op: "eq", value: "depot" }], { fuel: 2 }),
    ]);

  it("links quirks whose end state meets another's start conditions, in either insertion order", () => {
    const g = build();
    expect(g.next("a").sort()).toEqual(["b", "c"]);
    expect(g.next("b")).toEqual(["c"]);
    expect(g.next("d")).toEqual(["e"]);
    // nodes with no start conditions get no automatic incoming links
    expect(g.edges().some((e) => e.to === "a" || e.to === "d")).toBe(false);
    const reversed = new QuirkArchive("w", build().all().reverse());
    expect(reversed.edges().map((e) => `${e.from}>${e.to}`).sort()).toEqual(g.edges().map((e) => `${e.from}>${e.to}`).sort());
  });

  it("finds chains from any start, including skipped links, without forcing a shape", () => {
    const g = build();
    const chains = g.chains().map((c) => c.join(">"));
    expect(chains).toEqual(expect.arrayContaining(["a>b", "a>b>c", "a>c", "b>c", "d>e"]));
    expect(g.chains({ from: ["a"], maxDepth: 2 }).map((c) => c.join(">")).sort()).toEqual(["a>b", "a>c"]);
    expect(g.chains({ maxChains: 2 })).toHaveLength(2);
    expect([...g.reachable(["a"])].sort()).toEqual(["a", "b", "c"]);
  });

  it("handles chains hundreds deep without recursion", () => {
    const nodes = Array.from({ length: 400 }, (_, i) => q(`n${i}`, i === 0 ? [] : [{ key: "step", op: "eq", value: i - 1 }], { step: i }));
    const g = new QuirkArchive("w", nodes);
    const longest = g.chains({ from: ["n0"], maxDepth: 1000, maxChains: 10_000 }).at(-1)!;
    expect(longest).toHaveLength(400);
  });

  it("refuses bad links unless forced, and keeps manual links through JSON", () => {
    const g = build();
    expect(() => g.link("c", "b")).toThrow(/does not satisfy/);
    g.link("c", "b", { force: true });
    const back = QuirkArchive.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(back.next("c")).toEqual(["b"]);
    expect(back.edges()).toHaveLength(g.edges().length);
  });

  it("credit-back raises stepping stones that are useless alone", () => {
    const g = build();
    g.creditBack(["a", "b", "c"], 30);
    expect(g.get("a")!.value).toBeCloseTo(1);
    expect(g.get("b")!.value).toBeCloseTo(1);
    expect(g.get("d")!.value).toBe(0);
  });

  it("rejects duplicates and quirks from another world", () => {
    const g = build();
    expect(() => g.add(q("a", [], {}))).toThrow(/already/);
    expect(() => g.add({ ...q("z", [], {}), world: "other" })).toThrow(/world/);
  });
});

describe("quirk test (surprise)", () => {
  it("flags results outside the CI of the prediction, including losing ones", () => {
    expect(isQuirk({ measured: 141, ci95: 49, predicted: 0 })).toBe(true);
    expect(isQuirk({ measured: -80, ci95: 30, predicted: 0 })).toBe(true);
    expect(isQuirk({ measured: 12, ci95: 30, predicted: 0 })).toBe(false);
    expect(surprise({ measured: 0, ci95: 0, predicted: 0 })).toBe(0);
  });
});

describe("seeding from the hackathon results", () => {
  it("carries over every judged quirk and only measured effects", () => {
    const read = (n: string) => JSON.parse(readFileSync(repoPath("results", n), "utf8"));
    const g = seedRebuiltArchive(read("quirks.json"), read("lab.json"));
    expect(g.size).toBe(11);
    const trench = g.get("trench_shoot_on_move_refill")!;
    expect(trench.effect.value).toBe(141.3);
    expect(trench.notes).toMatch(/G407/);
    expect(g.get("tower_post_up")!.legality).toBe("RISKY");
    expect(g.get("tower_post_up")!.start).toHaveLength(2);
    expect(g.all().filter((x) => x.effect.value !== null)).toHaveLength(3);
    expect(g.all().every((x) => x.predicted === null)).toBe(true);
  });
});
