/**
 * pnpm ingest:rules (owner: P5): NDI Extract over the official game manual.
 *
 * Asks NDI for the game constants our config still marks TODO_VERIFY_AGAINST_MANUAL (plus the
 * ones marked VERIFIED, as a cross-check), each with a page citation, then:
 *   - writes data/rules/rules.json                (Rule[]: text, citation, config path + value)
 *   - writes results/ingest_rules.json            (per constant: config value vs manual value)
 *   - records the job in the usage ledger         (docs, pages and NDI's own reported cost)
 * It never edits config/default.json: a human applies the verified values after reading the
 * citations. The raw NDI job is kept in cache/ndi/ (gitignored) so reruns do not pay twice.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RuleSchema, type Config, type Rule } from "../contracts";
import { recordUsage } from "../ledger";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

/** One constant we ask the manual for. `read` pulls the matching value out of our config. */
interface Ask {
  field: string;
  description: string;
  type: "number" | "string" | "boolean";
  configPath: string | null;
  read?: (cfg: Config) => unknown;
  /** Converts the manual's unit to the config's unit (for example inches to metres). */
  convert?: (v: number) => number;
}
const inchesToM = (v: number) => Math.round(v * 0.0254 * 1000) / 1000;
const lbToKg = (v: number) => Math.round(v * 0.45359237 * 1000) / 1000;

const ASKS: Ask[] = [
  { field: "auto_seconds", type: "number", description: "Length of the autonomous period (AUTO) in seconds.", configPath: "game.autoS", read: (c) => c.game.autoS.value },
  { field: "teleop_seconds", type: "number", description: "Total length of the teleoperated period (TELEOP) in seconds, including the transition shift, all alliance shifts and the end game.", configPath: "game.teleopS", read: (c) => c.game.teleopS.value },
  { field: "transition_shift_seconds", type: "number", description: "Length in seconds of the TRANSITION SHIFT at the start of TELEOP, when both HUBS are active.", configPath: "game.hubShiftSchedule.transitionS", read: (c) => c.game.hubShiftSchedule.value.transitionS },
  { field: "alliance_shift_seconds", type: "number", description: "Length in seconds of ONE alternating ALLIANCE SHIFT (SHIFT 1, SHIFT 2, ...) during TELEOP.", configPath: "game.hubShiftSchedule.shiftS", read: (c) => c.game.hubShiftSchedule.value.shiftS },
  { field: "number_of_alliance_shifts", type: "number", description: "How many alternating ALLIANCE SHIFTS there are in TELEOP, not counting the transition shift or the end game.", configPath: "game.hubShiftSchedule.numShifts", read: (c) => c.game.hubShiftSchedule.value.numShifts },
  { field: "end_game_seconds", type: "number", description: "Length in seconds of the END GAME at the end of TELEOP, when both HUBS are active.", configPath: "game.endgameS", read: (c) => c.game.endgameS.value },
  { field: "auto_winner_hub_inactive_first", type: "boolean", description: "True if the ALLIANCE that scores more FUEL in AUTO has its own HUB inactive during the first alliance shift (SHIFT 1).", configPath: "game.hubShiftSchedule.autoWinnerInactiveFirst", read: (c) => c.game.hubShiftSchedule.value.autoWinnerInactiveFirst },
  { field: "hub_deactivation_warning_seconds", type: "number", description: "How many seconds before a HUB deactivates its lights or the field warn that it is about to become inactive.", configPath: "game.hubDeactivationWarningS", read: (c) => c.game.hubDeactivationWarningS.value },
  { field: "fuel_points_active_hub", type: "number", description: "MATCH points for one FUEL scored in an active HUB.", configPath: "game.fuelPointsActiveHub", read: (c) => c.game.fuelPointsActiveHub.value },
  { field: "fuel_points_inactive_hub", type: "number", description: "MATCH points for one FUEL scored in an inactive HUB.", configPath: "game.fuelPointsInactiveHub", read: (c) => c.game.fuelPointsInactiveHub.value },
  { field: "tower_level_1_teleop_points", type: "number", description: "MATCH points for one ROBOT at TOWER LEVEL 1 at the end of TELEOP.", configPath: "game.towerTeleopPoints[0]", read: (c) => c.game.towerTeleopPoints.value[0] },
  { field: "tower_level_2_teleop_points", type: "number", description: "MATCH points for one ROBOT at TOWER LEVEL 2 at the end of TELEOP.", configPath: "game.towerTeleopPoints[1]", read: (c) => c.game.towerTeleopPoints.value[1] },
  { field: "tower_level_3_teleop_points", type: "number", description: "MATCH points for one ROBOT at TOWER LEVEL 3 at the end of TELEOP.", configPath: "game.towerTeleopPoints[2]", read: (c) => c.game.towerTeleopPoints.value[2] },
  { field: "tower_level_1_auto_points", type: "number", description: "MATCH points for one ROBOT at TOWER LEVEL 1 at the end of AUTO.", configPath: "game.towerAutoL1Points", read: (c) => c.game.towerAutoL1Points.value },
  { field: "minor_foul_points", type: "number", description: "MATCH points credited to the opponent for a MINOR FOUL.", configPath: "game.minorFoulPoints", read: (c) => c.game.minorFoulPoints.value },
  { field: "major_foul_points", type: "number", description: "MATCH points credited to the opponent for a MAJOR FOUL.", configPath: "game.majorFoulPoints", read: (c) => c.game.majorFoulPoints.value },
  { field: "max_preloaded_fuel_per_robot", type: "number", description: "Maximum number of FUEL a ROBOT may be preloaded with before the MATCH.", configPath: "game.maxPreloadFuel", read: (c) => c.game.maxPreloadFuel.value },
  { field: "pin_limit_seconds", type: "number", description: "Maximum number of seconds a ROBOT may PIN an opponent ROBOT before a violation.", configPath: "game.pinning.limitS", read: (c) => c.game.pinning.value.limitS },
  { field: "pin_rule_id", type: "string", description: "The rule number of the PINNING rule (for example G###).", configPath: "game.pinning.clauseId", read: (c) => c.game.pinning.value.clauseId },
  { field: "pin_violation", type: "string", description: "The violation for PINNING too long: MINOR FOUL or MAJOR FOUL (answer 'minor' or 'major').", configPath: "game.pinning.severity", read: (c) => c.game.pinning.value.severity },
  { field: "pin_release_distance_inches", type: "number", description: "Distance in inches a ROBOT must back away to end a PIN.", configPath: "game.pinning.releaseDistanceM", read: (c) => c.game.pinning.value.releaseDistanceM, convert: inchesToM },
  { field: "field_length_inches", type: "number", description: "Length of the FIELD in inches (the long dimension, ALLIANCE WALL to ALLIANCE WALL).", configPath: "field.lengthM", read: (c) => c.field.lengthM.value, convert: inchesToM },
  { field: "field_width_inches", type: "number", description: "Width of the FIELD in inches (the short dimension).", configPath: "field.widthM", read: (c) => c.field.widthM.value, convert: inchesToM },
  { field: "alliance_zone_depth_inches", type: "number", description: "Depth of an ALLIANCE ZONE in inches, measured from the ALLIANCE WALL.", configPath: "field.allianceZoneDepthM", read: (c) => c.field.allianceZoneDepthM.value, convert: inchesToM },
  { field: "fuel_weight_pounds", type: "number", description: "Weight of one FUEL in pounds.", configPath: "game.fuelMassKg", read: (c) => c.game.fuelMassKg.value, convert: lbToKg },
  { field: "fuel_staged_in_neutral_zone", type: "number", description: "Number of FUEL staged in the NEUTRAL ZONE at the start of a MATCH.", configPath: "game.fuelStart.neutral", read: (c) => c.game.fuelStart.value.neutral },
  { field: "fuel_staged_in_each_depot", type: "number", description: "Number of FUEL staged in each DEPOT at the start of a MATCH.", configPath: "game.fuelStart.depotEach", read: (c) => c.game.fuelStart.value.depotEach },
  { field: "fuel_staged_in_each_outpost", type: "number", description: "Number of FUEL staged in each OUTPOST at the start of a MATCH.", configPath: "game.fuelStart.outpostEach", read: (c) => c.game.fuelStart.value.outpostEach },
  { field: "total_fuel_in_match", type: "number", description: "Total number of FUEL in a MATCH.", configPath: null },
  { field: "trench_clearance_height_inches", type: "number", description: "Height in inches of the opening a ROBOT must fit under to drive through the TRENCH.", configPath: null },
];

const cfg = loadConfig();
const key = process.env[cfg.ndi.apiKeyEnv];
const manualUrl = cfg.ndi.manualUrls[0];
if (!key || !manualUrl) {
  console.error(`[ingest:rules] need ${cfg.ndi.apiKeyEnv} and at least one ndi.manualUrls entry.`);
  process.exit(1);
}
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
const cacheDir = repoPath("cache", "ndi");
const cacheFile = path.join(cacheDir, "manual-extract.json");
mkdirSync(cacheDir, { recursive: true });

async function runJob(): Promise<any> {
  if (existsSync(cacheFile) && !process.argv.includes("--fresh")) {
    console.log(`[ingest:rules] using cached NDI job ${cacheFile} (pass --fresh to run it again)`);
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  }
  const started = performance.now();
  const create = await fetch(`${cfg.ndi.baseUrl}/v1/documents/extract?wait_seconds=${cfg.ndi.waitSeconds}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: { type: "url", url: manualUrl, file_name: "2026GameManual.pdf" },
      schema: { type: "object", properties: Object.fromEntries(ASKS.map((a) => [a.field, { type: a.type, description: a.description }])) },
      instructions: "This is the FIRST Robotics Competition 2026 REBUILT game manual. Use only values the manual states. Leave a field empty when the manual does not state it.",
      citations: { enabled: true, include_source_text: true },
    }),
    signal: AbortSignal.timeout((cfg.ndi.waitSeconds + 30) * 1000),
  });
  let job: any = await create.json().catch(() => ({}));
  if (create.status !== 200 && create.status !== 202) {
    console.error(`[ingest:rules] NDI refused the job: http ${create.status} ${JSON.stringify(job.error ?? job).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`[ingest:rules] job ${job.job_id} ${job.status}`);
  while (!["succeeded", "failed", "cancelled"].includes(job.status)) {
    await new Promise((done) => setTimeout(done, 5000));
    job = await (await fetch(`${cfg.ndi.baseUrl}/v1/documents/jobs/${job.job_id}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
    console.log(`[ingest:rules]   ${job.status}${job.progress ? ` ${JSON.stringify(job.progress).slice(0, 80)}` : ""}`);
  }
  // The charge can settle a moment after the job finishes.
  for (let i = 0; i < 6 && job.status === "succeeded" && !job.cost; i++) {
    await new Promise((done) => setTimeout(done, 3000));
    job = await (await fetch(`${cfg.ndi.baseUrl}/v1/documents/jobs/${job.job_id}`, { headers, signal: AbortSignal.timeout(30_000) })).json();
  }
  if (job.status !== "succeeded") {
    console.error(`[ingest:rules] job ${job.status}: ${JSON.stringify(job.error ?? {}).slice(0, 400)}`);
    process.exit(1);
  }
  const lines: any[] = job.cost?.lines ?? [];
  const pages = Math.max(0, ...lines.filter((l) => l.unit === "page").map((l) => Number(l.quantity) || 0));
  recordUsage(cfg, { tool: "ndi", purpose: "rules_extract", model: "ndi-extract", latencyMs: performance.now() - started, costUsd: Number(job.cost?.total_usd ?? 0), counts: { docs: 1, pages } });
  writeFileSync(cacheFile, JSON.stringify(job, null, 2) + "\n");
  console.log(`[ingest:rules] done: ${pages} pages, cost $${job.cost?.total_usd ?? "?"} (as reported by NDI)`);
  return job;
}

const job = await runJob();
const fields: any[] = job.result?.fields ?? [];
const pageOf = (citation: any): number | null => {
  const loc = citation?.location ?? {};
  const page = loc.page ?? loc.page_number ?? loc.page_index ?? loc.pages?.[0] ?? null;
  return typeof page === "number" && page > 0 ? page : null;
};
const quote25 = (text: unknown) => (typeof text === "string" && text.trim() ? text.trim().split(/\s+/).slice(0, 25).join(" ") : null);
const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02) : String(a).toLowerCase() === String(b).toLowerCase());

const rules: Rule[] = [];
const rows: Record<string, unknown>[] = [];
for (const ask of ASKS) {
  const f = fields.find((x) => x.path === `/${ask.field}` || x.path === ask.field);
  const found = f?.status === "found" && f.value !== null && f.value !== undefined;
  const citation = f?.citations?.[0];
  const page = pageOf(citation);
  const manualValue = found ? (ask.convert && typeof f.value === "number" ? ask.convert(f.value) : f.value) : null;
  const configValue = ask.read ? ask.read(cfg) : null;
  const agrees = found && ask.configPath !== null ? same(manualValue, configValue) : null;
  rows.push({ field: ask.field, configPath: ask.configPath, status: f?.status ?? "missing", confidence: f?.confidence ?? null, manualRaw: found ? f.value : null, manualValue, configValue, agrees, page, quote: quote25(citation?.source_text) });
  if (found && page !== null) {
    rules.push(
      RuleSchema.parse({
        id: ask.field,
        text: `${ask.description} Manual value: ${f.value}.`,
        citation: { document: "2026 FRC Game Manual (REBUILT)", page, quote: quote25(citation?.source_text) },
        config: ask.configPath ? { path: ask.configPath, value: manualValue } : null,
        parser: "ndi",
      }),
    );
  }
}

const rulesFile = repoPath(...cfg.ndi.rulesFile.split("/"));
mkdirSync(path.dirname(rulesFile), { recursive: true });
writeFileSync(rulesFile, JSON.stringify({ source: manualUrl, generatedTs: new Date().toISOString(), rules }, null, 2) + "\n");

const mapped = rows.filter((r) => r.configPath !== null);
const cited = mapped.filter((r) => r.status === "found" && r.page !== null);
const summary = {
  constantsAsked: mapped.length,
  foundWithPageCitation: cited.length,
  agreeWithConfig: cited.filter((r) => r.agrees === true).length,
  disagreeWithConfig: cited.filter((r) => r.agrees === false).map((r) => r.configPath),
  notFound: mapped.filter((r) => r.status !== "found").map((r) => r.configPath),
  ndi_rules_verified_pct: Math.round((100 * cited.length) / mapped.length),
  ndiCostUsd: Number(job.cost?.total_usd ?? 0),
};
writeResults({ experiment: "ingest_rules", createdTs: new Date().toISOString(), isMock: false, gitCommit: gitCommit(), simHash: simHash(cfg), config: { manualUrl, ndi: cfg.ndi }, rows, summary });

console.log("\nfield                               status      config -> manual        page");
for (const r of rows) console.log(`${String(r.field).padEnd(35)} ${String(r.status).padEnd(11)} ${String(r.configValue ?? "-").padStart(8)} -> ${String(r.manualValue ?? "-").padEnd(12)} ${r.agrees === false ? "DIFFERS" : r.agrees ? "ok" : ""}  ${r.page ?? ""}`);
console.log(`\n[ingest:rules] ${summary.foundWithPageCitation}/${summary.constantsAsked} constants found with a page citation (${summary.ndi_rules_verified_pct}%); wrote ${rulesFile}`);
