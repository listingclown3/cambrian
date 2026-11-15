/**
 * pnpm exec tsx src/history/ingest/scoutingExtract.ts [--limit N] [--fresh] [--dir <folder>]
 *
 * Measures how accurately NDI Extract recovers a robot profile from each messy (fabricated)
 * scouting sheet in <dir>/sheets, scored against <dir>/truth.json.
 * Writes <dir>/extracted.json and results/ingest_scouting.json.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { loadConfig, repoPath } from "../../util/config";
import { gitCommit, simHash } from "../../util/provenance";
import { writeResults } from "../../util/runLog";
import { citationQuote, ndiJob, ndiPages, ndiUpload } from "./ndiClient";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const limitN = opt("--limit") ? Number(opt("--limit")) : Infinity;
const fresh = flag("--fresh");
const dir = path.resolve(opt("--dir") ?? repoPath("data", "scouting"));

const FT_S = 0.3048, LB = 0.45359237, FT = 0.3048;
const KEYS = ["teamNumber", "shooterType", "lanes", "shootOnMove", "capacity", "fireRatePerS", "intakeWidth", "drivetrain", "speedEmptyMps", "massEmptyKg", "heightClass", "fitsUnderTrench", "climbLevel", "passRangeM"] as const;
type Key = (typeof KEYS)[number];
type Values = Partial<Record<Key, number | string | boolean>>;

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const SCHEMA = {
  type: "object",
  properties: {
    team_number: num("FRC team number of the robot."),
    shooter_type: str("Shooter mechanism type: one of drum, lanes, turret, dumper, none. Use 'lanes' for multi-lane or N-lane shooters; 'none' if the robot cannot shoot."),
    lanes: num("Number of shooter lanes (1 to 4)."),
    shoot_on_move: bool("True if the robot can shoot while driving."),
    capacity: num("Fuel capacity: how many fuel (balls) the robot can hold."),
    fire_rate_value: num("Shooting rate, number exactly as written."),
    fire_rate_unit: str("Unit of the shooting rate: 'per_s' (per second) or 'per_min' (per minute)."),
    intake_width: str("Intake width: 'narrow' or 'wide'."),
    drivetrain: str("Drivetrain: 'swerve' or 'tank' (tank includes WCD, 6WD, west coast, tank drive)."),
    top_speed_value: num("Top driving speed with the robot empty, number exactly as written."),
    top_speed_unit: str("Unit of the top speed: 'ft/s' (includes fps) or 'm/s'."),
    weight_value: num("Robot weight (empty), number exactly as written."),
    weight_unit: str("Unit of the weight: 'lb' or 'kg'."),
    height_class: str("Robot height class: 'short' or 'tall'."),
    fits_under_trench: bool("True if the robot fits under the trench."),
    climb_level: num("Highest tower climb level the robot reaches: 0, 1, 2 or 3 (0 means no climb)."),
    pass_range_value: num("Distance the robot can pass fuel, number exactly as written."),
    pass_range_unit: str("Unit of the pass range: 'ft' or 'm'."),
  },
};
const INSTRUCTIONS =
  "This is one FRC scouting sheet describing ONE robot. Use only what the sheet states. Leave a field empty when the sheet does not state it; do not guess. When two notes conflict, the later note wins. Ignore irrelevant chatter. Report numbers exactly as written together with their unit.";

const round = (n: number) => Math.round(n * 1000) / 1000;
const low = (v: unknown) => String(v).trim().toLowerCase();

function normalise(fields: any[]): { values: Values; src: Partial<Record<Key, any>> } {
  const get = (p: string): { value: any; field: any } | null => {
    const f = fields.find((x) => x.path === `/${p}` || x.path === p);
    return f && f.status === "found" && f.value !== null && f.value !== undefined && f.value !== "" ? { value: f.value, field: f } : null;
  };
  const values: Values = {};
  const src: Partial<Record<Key, any>> = {};
  const set = (k: Key, v: number | string | boolean, f: any) => { values[k] = v; src[k] = f; };
  const n = (p: string) => { const f = get(p); return f && f.value !== "" && Number.isFinite(Number(f.value)) ? { v: Number(f.value), f: f.field } : null; };
  const unit = (p: string, dflt: string) => low(get(p)?.value ?? dflt);

  const t = n("team_number"); if (t) set("teamNumber", t.v, t.f);
  const st = get("shooter_type");
  if (st) {
    const s = low(st.value);
    set("shooterType", /drum/.test(s) ? "drum" : /lane/.test(s) ? "lanes" : /turret/.test(s) ? "turret" : /dump/.test(s) ? "dumper" : /^none|no shoot/.test(s) ? "none" : s, st.field);
  }
  const l = n("lanes"); if (l) set("lanes", l.v, l.f);
  const som = get("shoot_on_move"); if (som && typeof som.value === "boolean") set("shootOnMove", som.value, som.field);
  const c = n("capacity"); if (c) set("capacity", c.v, c.f);
  const fr = n("fire_rate_value"); if (fr) set("fireRatePerS", round(/min/.test(unit("fire_rate_unit", "per_s")) ? fr.v / 60 : fr.v), fr.f);
  const iw = get("intake_width"); if (iw) set("intakeWidth", /wide/.test(low(iw.value)) ? "wide" : /narrow/.test(low(iw.value)) ? "narrow" : low(iw.value), iw.field);
  const dt = get("drivetrain"); if (dt) { const s = low(dt.value); set("drivetrain", /swerve/.test(s) ? "swerve" : /tank|wcd|west|6wd|6 wheel|skid/.test(s) ? "tank" : s, dt.field); }
  const sp = n("top_speed_value"); if (sp) set("speedEmptyMps", round(/f/.test(unit("top_speed_unit", "m/s")) ? sp.v * FT_S : sp.v), sp.f);
  const w = n("weight_value"); if (w) set("massEmptyKg", round(/lb|pound/.test(unit("weight_unit", "kg")) ? w.v * LB : w.v), w.f);
  const h = get("height_class"); if (h) set("heightClass", /tall/.test(low(h.value)) ? "tall" : /short|low/.test(low(h.value)) ? "short" : low(h.value), h.field);
  const ft = get("fits_under_trench"); if (ft && typeof ft.value === "boolean") set("fitsUnderTrench", ft.value, ft.field);
  const cl = n("climb_level"); if (cl) set("climbLevel", cl.v, cl.f);
  const pr = n("pass_range_value"); if (pr) set("passRangeM", round(/f/.test(unit("pass_range_unit", "m")) ? pr.v * FT : pr.v), pr.f);
  return { values, src };
}

/** Numbers within 5% or 0.05 absolute (whichever is larger); enums and booleans exact. */
function matches(truthV: unknown, got: unknown): boolean {
  if (typeof truthV === "number" && typeof got === "number") return Math.abs(truthV - got) <= Math.max(0.05, Math.abs(truthV) * 0.05);
  return typeof truthV === typeof got && low(truthV) === low(got);
}

interface Sheet { sheetId: string; file: string; stated: Values }
interface Tally { correct: number; wrong: number; missed: number; hallucinated: number }
const zero = (): Tally => ({ correct: 0, wrong: 0, missed: 0, hallucinated: 0 });

const cfg = loadConfig();
const truth = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8"));
const sheets: Sheet[] = (truth.sheets as Sheet[]).slice(0, limitN);
console.log(`[scouting] ${sheets.length} sheets from ${dir}${fresh ? " (fresh)" : ""}`);

const byField: Record<string, Tally> = Object.fromEntries(KEYS.map((k) => [k, zero()]));
const errors: { sheet: string; field: string; truth: unknown; got: unknown; quote: string | null }[] = [];
const rows: Record<string, unknown>[] = [];
const extracted: any[] = [];
const fmtTally: Record<string, Tally> = {};

const pool = pLimit(4);
await Promise.all(
  sheets.map((sh) =>
    pool(async () => {
      const format = path.extname(sh.file).slice(1).toLowerCase();
      const row: Record<string, unknown> = { sheetId: sh.sheetId, file: sh.file, format, status: "failed", pages: 0, costUsd: 0, correct: 0, wrong: 0, missed: 0, hallucinated: 0 };
      rows.push(row);
      try {
        const buf = readFileSync(path.join(dir, "sheets", sh.file));
        const source = await ndiUpload(cfg, `scouting/${sh.file}`, buf);
        const job = await ndiJob(cfg, "extract", { source, schema: SCHEMA, instructions: INSTRUCTIONS, citations: { enabled: true, include_source_text: true } }, { purpose: "scouting_extract", cacheKey: `scouting-${sh.sheetId}`, fresh });
        row.status = job.status;
        row.pages = ndiPages(job);
        row.costUsd = Number(job.cost?.total_usd ?? 0);
        if (job.status !== "succeeded") { console.error(`[scouting] ${sh.sheetId} ${job.status}: ${JSON.stringify(job.error ?? {}).slice(0, 200)}`); return; }
        const { values, src } = normalise(job.result?.fields ?? []);
        const provenance: Record<string, unknown> = {};
        for (const k of Object.keys(values) as Key[]) provenance[k] = { source: `scouting:${sh.sheetId}`, quote: citationQuote(src[k]), parser: "ndi" };
        extracted.push({ sheetId: sh.sheetId, file: sh.file, values, provenance });
        const ft = (fmtTally[format] ??= zero());
        for (const k of KEYS) {
          const stated = k in sh.stated, got = k in values;
          let r: keyof Tally | null = null;
          if (stated && got) r = matches(sh.stated[k], values[k]) ? "correct" : "wrong";
          else if (stated) r = "missed";
          else if (got) r = "hallucinated";
          if (!r) continue;
          row[r] = (row[r] as number) + 1;
          byField[k][r]++;
          ft[r]++;
          if (r !== "correct") errors.push({ sheet: sh.sheetId, field: k, truth: sh.stated[k] ?? "(not stated)", got: values[k] ?? "(not found)", quote: citationQuote(src[k]) });
        }
      } catch (e) {
        row.status = `error: ${String((e as Error).message).slice(0, 150)}`;
        console.error(`[scouting] ${sh.sheetId} failed: ${row.status}`);
      }
    }),
  ),
);
rows.sort((a, b) => String(a.sheetId).localeCompare(String(b.sheetId)));
extracted.sort((a, b) => a.sheetId.localeCompare(b.sheetId));
errors.sort((a, b) => (a.sheet + a.field).localeCompare(b.sheet + b.field));
const costTotal = rows.reduce((s, r) => s + Number(r.costUsd), 0);

const tot = zero();
for (const t of Object.values(byField)) for (const k of Object.keys(tot) as (keyof Tally)[]) tot[k] += t[k];
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const acc = (t: Tally) => pct(t.correct, t.correct + t.wrong + t.missed);
const summary = {
  sheets: sheets.length,
  fieldsStated: tot.correct + tot.wrong + tot.missed,
  ...tot,
  accuracyPct: acc(tot),
  precisionPct: pct(tot.correct, tot.correct + tot.wrong + tot.hallucinated),
  byField,
  byFormat: Object.fromEntries(Object.entries(fmtTally).map(([f, t]) => [f, acc(t)])),
  ndiCostUsd: Math.round(costTotal * 10000) / 10000,
  inputsAreFabricated: true,
};

mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "extracted.json"), JSON.stringify({ generatedTs: new Date().toISOString(), note: "Sheets are fabricated; see truth.json", sheets: extracted }, null, 2) + "\n");
writeResults({ experiment: "ingest_scouting", createdTs: new Date().toISOString(), isMock: false, gitCommit: gitCommit(), simHash: simHash(cfg), config: { fabricatedInputs: true, dir: path.relative(repoPath(), dir), ndi: cfg.ndi }, rows, summary });

console.log("\nfield            correct wrong missed halluc  acc%");
for (const k of KEYS) {
  const t = byField[k];
  console.log(`${k.padEnd(16)} ${String(t.correct).padStart(7)} ${String(t.wrong).padStart(5)} ${String(t.missed).padStart(6)} ${String(t.hallucinated).padStart(6)}  ${acc(t)}`);
}
console.log(`\nby format: ${Object.entries(summary.byFormat).map(([f, a]) => `${f} ${a}%`).join(", ")}`);
console.log(`TOTAL correct ${tot.correct} wrong ${tot.wrong} missed ${tot.missed} hallucinated ${tot.hallucinated} | accuracy ${summary.accuracyPct}% precision ${summary.precisionPct}% | NDI cost $${summary.ndiCostUsd}`);
console.log("\nexample errors:");
for (const e of errors.slice(0, 10)) console.log(`  ${e.sheet} ${e.field}: truth=${JSON.stringify(e.truth)} got=${JSON.stringify(e.got)} quote=${JSON.stringify(e.quote)}`);
