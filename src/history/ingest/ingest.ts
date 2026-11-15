/**
 * pnpm ingest (owner: P5): NDI document intelligence.
 *
 * STUB. Steps for P5 (NDI API: POST {cfg.ndi.baseUrl}/v1/documents/{parse|extract|...} with
 * Authorization: Bearer <NACE_API_KEY>; jobs are asynchronous, see cfg.ndi._note):
 *   1. Manual + latest Team Update (cfg.ndi.manualUrls) -> Rule[] with page citations in
 *      cfg.ndi.rulesFile. A rule with `config` set overrides the matching
 *      TODO_VERIFY_AGAINST_MANUAL constant; report ndi_rules_verified_pct.
 *   2. The cfg.ndi.scoutingSheets messy fabricated scouting sheets (generate them here; this
 *      generator is the task to build with Intern as a coding agent, and its commit message must
 *      say "built with Intern") -> SourcedProfile[] with per-field provenance; score accuracy
 *      against the ground-truth profiles.
 *   3. Keenable pages in data/research/raw -> SourcedProfile[] in
 *      data/league/teams_from_docs.json (URL provenance) and ResearchNote[] in
 *      data/research/notes.json ({ claim, sourceUrl, quote <= 25 words }).
 *   4. Drex classifies each real robot's archetype (SourcedProfile.classifiedArchetype).
 *   5. Use the fallback parser only if NDI fails, and tag those values parser: "fallback".
 *   6. recordUsage(cfg, { tool: "ndi", purpose, counts: { docs, pages } }) for every real job.
 */
import { notImplementedYet } from "../../util/stub";

notImplementedYet(
  "ingest",
  "Use NDI to turn the game manual, scouting sheets and Keenable pages into rules, robot profiles and strategy notes, each with citations.",
  ["config/default.json (ndi.manualUrls)", "data/research/raw/", "data/scouting/"],
  ["data/rules/rules.json", "data/league/teams_from_docs.json", "data/research/notes.json", "results/ingest.json"],
  "P5",
);
