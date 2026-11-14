/**
 * pnpm headline (owner: P3)
 * Assemble the Headline numbers from the results files and write results/headline.json.
 *
 * Filled today, all from real runs:
 *   usage_*                 <- the usage ledger (runs/usage.jsonl)
 *   keenable_pages          <- data/research/sources.json
 *   ndi_rules_verified_pct  <- results/ingest_rules.json
 * Every benchmark number is null until its experiment runs. P3 fills each remaining key from the
 * matching results/<experiment>.json and sets all_real only when no contributing file is mock.
 */
import { existsSync, readFileSync } from "node:fs";
import { HeadlineSchema, emptyHeadline } from "../contracts";
import { readUsage, summarizeUsage, usageHeadline } from "../ledger";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

const cfg = loadConfig();
const readJson = (...parts: string[]): any | null => (existsSync(repoPath(...parts)) ? JSON.parse(readFileSync(repoPath(...parts), "utf8")) : null);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const sources = readJson("data", "research", "sources.json");
const ingestRules = readJson("results", "ingest_rules.json");

const headline = HeadlineSchema.parse({
  ...emptyHeadline(),
  ...usageHeadline(summarizeUsage(readUsage(cfg))),
  keenable_pages: numberOrNull(sources?.pages),
  ndi_rules_verified_pct: ingestRules?.isMock === false ? numberOrNull(ingestRules.summary?.ndi_rules_verified_pct) : null,
});
const file = writeResults({
  experiment: "headline",
  createdTs: new Date().toISOString(),
  isMock: false,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { note: "usage, research and rules numbers are real; no benchmark has contributed yet" },
  rows: [],
  summary: headline,
});
const filled = Object.entries(headline).filter(([, v]) => v !== null);
console.log(`[headline] ${filled.length} of ${Object.keys(headline).length} numbers filled; benchmark numbers are null until the benchmarks run (owner: P3).`);
for (const [key, value] of filled) console.log(`  ${key} = ${value}`);
console.log(`[headline] wrote ${file}`);
