/**
 * Shared helper for benchmark scripts that are not implemented yet (owner: P3).
 */
export function notImplementedYet(script: string, willDo: string, inputs: string[], outputs: string[]): void {
  console.log(`[${script}] STUB - not implemented yet (owner: P3).`);
  console.log(`  will: ${willDo}`);
  console.log(`  reads:  ${inputs.join(", ") || "-"}`);
  console.log(`  writes: ${outputs.join(", ") || "-"}`);
}
