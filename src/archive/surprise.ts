/**
 * The quirk test (notes/decisions.md, A): a result is a quirk when its measured effect differs
 * from what the prior predicted by more than the measurement noise (outside the 95% CI).
 * A quirk may lose on its own and still counts.
 */
export interface SurpriseInput {
  /** Measured effect (mean over paired runs). */
  measured: number;
  /** Half-width of the 95% confidence interval of `measured`. */
  ci95: number;
  /** Effect the prior predicted before the run. */
  predicted: number;
}

/** How far outside the noise the result landed, in CI half-widths (0 or less = not a quirk). */
export function surprise({ measured, ci95, predicted }: SurpriseInput): number {
  const gap = Math.abs(measured - predicted);
  if (ci95 <= 0) return gap > 0 ? Number.POSITIVE_INFINITY : 0;
  return gap / ci95 - 1;
}

export function isQuirk(input: SurpriseInput): boolean {
  return surprise(input) > 0;
}
