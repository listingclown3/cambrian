import { describe, expect, it } from "vitest";
import { meanAndHalfWidth } from "./labSim";

describe("meanAndHalfWidth", () => {
  it("gives mean and a t-based half-width", () => {
    const r = meanAndHalfWidth([1, 2, 3, 4, 5]);
    expect(r.mean).toBe(3);
    expect(r.ci95).toBeCloseTo((2.776 * Math.sqrt(2.5)) / Math.sqrt(5), 6);
  });
  it("zero width for identical values", () => {
    expect(meanAndHalfWidth([0, 0, 0]).ci95).toBe(0);
  });
});
