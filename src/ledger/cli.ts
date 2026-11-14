/**
 * pnpm usage (owner: P2): summarise the usage ledger and write results/usage.json.
 */
import { USAGE_TOOLS } from "../contracts";
import { loadConfig } from "../util/config";
import { readUsage, summarizeUsage, writeUsageResults } from "./index";

const cfg = loadConfig();
const summary = summarizeUsage(readUsage(cfg), cfg);
for (const tool of USAGE_TOOLS) {
  const t = summary.byTool[tool];
  const counts = Object.entries(t.counts).map(([k, n]) => `${k} ${n}`).join(", ");
  console.log(`${tool.padEnd(10)} calls ${String(t.calls).padStart(5)}  cost $${t.costUsd.toFixed(4)}${counts ? `  (${counts})` : ""}`);
}
console.log(`total      calls ${String(summary.totalCalls).padStart(5)}  cost $${summary.totalCostUsd.toFixed(4)}`);
console.log(`wrote ${writeUsageResults(cfg)}`);
