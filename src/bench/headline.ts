/**
 * pnpm headline (owner: P3)
 * Assemble the Headline numbers from the results files and write results/headline.json.
 *
 * STUB: only the usage_* keys are filled (from the usage ledger). Every benchmark number is null
 * until its experiment runs. P3 fills each key from the matching results/<experiment>.json and
 * sets all_real only when no contributing file is mock.
 */
import { HeadlineSchema, emptyHeadline } from "../contracts";
import { readUsage, summarizeUsage, usageHeadline } from "../ledger";
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

const cfg = loadConfig();
const headline = HeadlineSchema.parse({ ...emptyHeadline(), ...usageHeadline(summarizeUsage(readUsage(cfg))) });
const file = writeResults({
  experiment: "headline",
  createdTs: new Date().toISOString(),
  isMock: false,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { note: "no benchmark has contributed yet" },
  rows: [],
  summary: headline,
});
console.log(`[headline] STUB - benchmark numbers are null until the benchmarks run (owner: P3).`);
console.log(`[headline] wrote ${file}`);
