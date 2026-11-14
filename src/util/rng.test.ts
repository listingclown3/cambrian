import { describe, expect, it } from "vitest";
import { Rng, seedState } from "./rng";

describe("Rng", () => {
  it("resumes exactly from a saved state, including after a JSON round trip", () => {
    const a = Rng.fromSeed(123);
    for (let i = 0; i < 10; i++) a.next();
    const b = Rng.fromState(JSON.parse(JSON.stringify(a.getState())) as number[]);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });

  it("is reproducible per seed", () => {
    expect(seedState(7)).toEqual(seedState(7));
    expect(Rng.fromSeed(7).next()).toBe(Rng.fromSeed(7).next());
  });

  it("gives uncorrelated first draws for neighbouring seeds", () => {
    const firsts = Array.from({ length: 200 }, (_, seed) => Rng.fromSeed(seed).next());
    expect(firsts.every((v) => v >= 0 && v < 1)).toBe(true);
    const mean = firsts.reduce((x, y) => x + y, 0) / firsts.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    // spread across all ten deciles, not clumped
    expect(new Set(firsts.map((v) => Math.floor(v * 10))).size).toBe(10);
  });
});
