import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { ZERO_COST, addCost, costUsd } from "./cost";

describe("cost unit", () => {
  const rates = { ...loadConfig().costs, cpuUsdPerVcpuHour: 0.05, gpuUsdPerHour: 2 };

  it("sums model dollars, CPU time and GPU time into one USD figure", () => {
    const parts = addCost(addCost(ZERO_COST, { modelApiUsd: 1.5, modelCalls: 300, tokens: 90_000 }), { simCpuHours: 10, simSteps: 1_000_000, gpuHours: 0.5 });
    expect(costUsd(parts, rates)).toBeCloseTo(1.5 + 0.5 + 1);
    expect(parts.modelCalls).toBe(300);
  });

  it("refuses to price GPU time as free when no GPU rate is set", () => {
    expect(() => costUsd({ ...ZERO_COST, gpuHours: 1 }, { ...rates, gpuUsdPerHour: null })).toThrow(/gpuUsdPerHour/);
    expect(costUsd({ ...ZERO_COST, simCpuHours: 2 }, { ...rates, gpuUsdPerHour: null })).toBeCloseTo(0.1);
  });
});
