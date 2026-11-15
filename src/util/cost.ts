/**
 * The single cost unit (notes/decisions.md, "Cost unit"): USD, always reported with its parts.
 *
 *   cost_usd = model API dollars (billed prices, from the ledger)
 *            + simulator CPU-hours x costs.cpuUsdPerVcpuHour
 *            + GPU-hours x costs.gpuUsdPerHour
 *
 * Every comparison between search methods must be made at equal cost_usd.
 */
import { CostPartsSchema, type Config, type CostParts } from "../contracts";

export const ZERO_COST: CostParts = { modelApiUsd: 0, simCpuHours: 0, gpuHours: 0, simSteps: 0, modelCalls: 0, tokens: 0 };

export function addCost(a: CostParts, b: Partial<CostParts>): CostParts {
  return CostPartsSchema.parse({
    modelApiUsd: a.modelApiUsd + (b.modelApiUsd ?? 0),
    simCpuHours: a.simCpuHours + (b.simCpuHours ?? 0),
    gpuHours: a.gpuHours + (b.gpuHours ?? 0),
    simSteps: a.simSteps + (b.simSteps ?? 0),
    modelCalls: a.modelCalls + (b.modelCalls ?? 0),
    tokens: a.tokens + (b.tokens ?? 0),
  });
}

/** Total in USD. Throws if GPU time was used but no GPU rate is configured, rather than counting it as free. */
export function costUsd(parts: CostParts, rates: Config["costs"]): number {
  const p = CostPartsSchema.parse(parts);
  if (p.gpuHours > 0 && rates.gpuUsdPerHour === null) throw new Error("GPU hours were used but costs.gpuUsdPerHour is not set; enter the rate from your invoice");
  return p.modelApiUsd + p.simCpuHours * rates.cpuUsdPerVcpuHour + p.gpuHours * (rates.gpuUsdPerHour ?? 0);
}
