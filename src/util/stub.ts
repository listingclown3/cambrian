/**
 * Shared helper for CLI scripts that are not implemented yet.
 */
export function notImplementedYet(script: string, willDo: string, inputs: string[], outputs: string[], owner = "P3"): void {
  console.log(`[${script}] STUB - not implemented yet (owner: ${owner}).`);
  console.log(`  will: ${willDo}`);
  console.log(`  reads:  ${inputs.join(", ") || "-"}`);
  console.log(`  writes: ${outputs.join(", ") || "-"}`);
}
