/**
 * pnpm headline (owner: P3)
 * Assemble the Headline numbers from the results files and write results/headline.json.
 *
 * STUB: no experiment has run, so every number is null. P3 fills each key from the matching
 * results/<experiment>.json and sets all_real only when no contributing file is mock.
 */
import { HeadlineSchema, emptyHeadline } from "../contracts";
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

const cfg = loadConfig();
const headline = HeadlineSchema.parse(emptyHeadline());
const file = writeResults({
  experiment: "headline",
  createdTs: new Date().toISOString(),
  isMock: false,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { note: "no experiment has contributed yet" },
  rows: [],
  summary: headline,
});
console.log(`[headline] STUB - every number is null until the benchmarks run (owner: P3).`);
console.log(`[headline] wrote ${file}`);
