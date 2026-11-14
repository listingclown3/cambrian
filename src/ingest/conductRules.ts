/**
 * pnpm exec tsx src/ingest/conductRules.ts (owner: P5): NDI Extract of robot-conduct rules
 * from the official manual -> data/rules/conduct_rules.json. One extract job (cached).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, repoPath } from "../util/config";
import { citationPage, citationQuote, ndiJob } from "./ndiClient";

const TOPICS: { name: string; topic: string; about: string }[] = [
  { name: "pinning", topic: "pinning an opponent robot", about: "PINNING an opponent ROBOT for too long" },
  { name: "damage", topic: "damaging or tipping an opponent robot", about: "damaging or tipping over an opponent ROBOT" },
  { name: "inside_frame", topic: "contact inside an opponent's frame perimeter", about: "extending into / contacting inside an opponent ROBOT's FRAME PERIMETER" },
  { name: "tower_contact", topic: "contacting an opponent climbing or on the TOWER", about: "contacting an opponent ROBOT that is climbing or on the TOWER" },
  { name: "protected_zone", topic: "interfering with an opponent in a protected zone", about: "interfering with an opponent ROBOT in a protected zone" },
  { name: "fuel_control", topic: "controlling more FUEL than allowed", about: "controlling or possessing more FUEL than allowed (a numeric limit)" },
  { name: "fuel_launch", topic: "launching FUEL out of the field or at people", about: "launching FUEL out of the FIELD or at people" },
  { name: "blocking", topic: "blocking or trapping multiple opponents / shutting down major gameplay", about: "blocking or trapping multiple opponents, or shutting down major portions of gameplay" },
  { name: "leaving_field", topic: "robots leaving the field or extending beyond a size limit", about: "ROBOTS leaving the FIELD or extending beyond a size limit" },
  { name: "auto_protected", topic: "entering the opponent's protected area during AUTO", about: "entering the opponent's protected area during AUTO" },
  { name: "human_player", topic: "human player / OUTPOST FUEL feeding rules", about: "HUMAN PLAYER or OUTPOST rules about feeding FUEL" },
  { name: "forcing", topic: "intentionally forcing an opponent to break a rule", about: "intentionally causing an opponent to violate a rule" },
];

const cfg = loadConfig();
const properties: Record<string, unknown> = {};
for (const t of TOPICS) {
  properties[`${t.name}_rule_id`] = { type: "string", description: `Rule number (like G418) of the rule about ${t.about}. Empty if the manual has no such rule.` };
  properties[`${t.name}_rule_text`] = { type: "string", description: `The requirement of the rule about ${t.about}, in the manual's own words, up to 60 words. Empty if the manual has no such rule.` };
  properties[`${t.name}_violation`] = { type: "string", description: `The penalty for breaking the rule about ${t.about}, for example MINOR FOUL or MAJOR FOUL. Empty if none.` };
}
const schema = { type: "object", properties };
const instructions = "This is the FIRST Robotics Competition 2026 REBUILT game manual. Find the specific numbered rules (G###) in the ROBOT conduct / gameplay rule sections. Use only what the manual states; if the manual has no rule on a topic, leave the fields empty. Do not invent rules.";
const common = { schema, instructions, citations: { enabled: true, include_source_text: true } };

let source: any = { type: "parse_result", job_id: "06c60f94-cead-48c4-9c75-efeda774bdcc" };
let job: any;
try {
  job = await ndiJob(cfg, "extract", { source, ...common }, { purpose: "conduct_rules_extract", cacheKey: "manual-conduct-rules" });
  if (job.status !== "succeeded") throw new Error(`job ${job.status}: ${JSON.stringify(job.error ?? {}).slice(0, 300)}`);
} catch (e) {
  console.log(`[conductRules] parse_result source failed (${(e as Error).message}); falling back to url`);
  source = { type: "url", url: cfg.ndi.manualUrls[0], file_name: "2026GameManual.pdf" };
  job = await ndiJob(cfg, "extract", { source, ...common }, { purpose: "conduct_rules_extract", cacheKey: "manual-conduct-rules" });
  if (job.status !== "succeeded") throw new Error(`NDI extract ${job.status}: ${JSON.stringify(job.error ?? {}).slice(0, 300)}`);
}
if (job.source?.type) source = job.source; // a cached job remembers which source actually worked
console.log(`[conductRules] source type ${source.type}, cost $${job.cost?.total_usd ?? "?"}`);

const fields: any[] = job.result?.fields ?? [];
const get = (p: string) => fields.find((f) => f.path === `/${p}` || f.path === p);
const val = (f: any): string | null => (f && f.status !== "not_found" && typeof f.value === "string" && f.value.trim() ? f.value.trim() : null);

const rules: any[] = [];
const missing: string[] = [];
for (const t of TOPICS) {
  const fid = get(`${t.name}_rule_id`), ftx = get(`${t.name}_rule_text`), fv = get(`${t.name}_violation`);
  const id = val(fid), text = val(ftx);
  if (!id || !text) { missing.push(t.topic); continue; }
  if (rules.some((r) => r.id === id)) { console.log(`[conductRules] ${t.topic}: same rule ${id} as an earlier topic, kept once`); continue; }
  const src = ftx?.citations?.length ? ftx : fid;
  rules.push({ topic: t.topic, id, text, violation: val(fv), page: citationPage(ftx) ?? citationPage(fid), quote: citationQuote(src, 25) });
}
const file = repoPath("data", "rules", "conduct_rules.json");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ source, generatedTs: new Date().toISOString(), rules }, null, 2) + "\n");
for (const r of rules) console.log(`\n${r.id} (p.${r.page ?? "?"}) [${r.violation ?? "?"}] ${r.topic}\n  ${r.text}`);
console.log(`\nNot found: ${missing.join("; ") || "(none)"}\n[conductRules] ${rules.length}/${TOPICS.length} rules; wrote ${file}`);
