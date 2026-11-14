/**
 * pnpm exec tsx src/ingest/ruleJudge.ts [--model drex-latest] (owner: P5)
 * Drex as a rule judge: for each fabricated incident, "does it violate rule X as written?".
 * Reports AGREEMENT WITH DRAFT LABELS (labels are an unconfirmed AI draft), not accuracy.
 * One drexAsk call per rule (the state is the rule text; one noul question per incident).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";
import { drexAsk, type DrexQuestion } from "./drexClient";

const cfg = loadConfig();
const mi = process.argv.indexOf("--model");
const model = mi >= 0 ? process.argv[mi + 1] : undefined;

const conduct = JSON.parse(readFileSync(repoPath("data", "rules", "conduct_rules.json"), "utf8"));
const incidents: any[] = JSON.parse(readFileSync(repoPath("data", "rules", "incidents.template.json"), "utf8")).incidents;
const rules = new Map<string, any>((conduct.rules as any[]).map((r) => [r.id, r]));

const rows: Record<string, any>[] = [];
const latencies: number[] = [];
const perCall: number[] = [];
let usedModel = model ?? "";
for (const [ruleId, rule] of rules) {
  const group = incidents.filter((i) => i.ruleId === ruleId);
  if (group.length === 0) continue;
  const questions: Record<string, DrexQuestion> = {};
  for (const inc of group) questions[inc.id] = { type: "noul", instructions: `Incident: ${inc.description}\nDoes this incident violate rule ${ruleId} as written?` };
  const res = await drexAsk(cfg, { state: { rule: { id: rule.id, text: rule.text, violation: rule.violation } }, questions, purpose: "rule_judge", model });
  latencies.push(res.latencyMs);
  perCall.push(group.length);
  usedModel = res.model || usedModel;
  for (const inc of group) {
    const p = res.answers[inc.id]?.noul;
    const pYes = typeof p === "number" ? p : null;
    const judged = pYes === null ? null : pYes >= 0.5;
    rows.push({ id: inc.id, ruleId, rulePage: rule.page ?? null, difficulty: inc.difficulty, expectedViolation: inc.expectedViolation, pYes, judgedViolation: judged, agrees: judged === null ? null : judged === inc.expectedViolation, labelSource: inc.labelSource });
  }
}
const unknown = incidents.filter((i) => !rules.has(i.ruleId)).map((i) => i.id);
if (unknown.length) console.log(`[ruleJudge] skipped ${unknown.length} incidents whose rule was not extracted: ${unknown.join(", ")}`);

const pct = (rs: Record<string, any>[]) => (rs.length ? Math.round((1000 * rs.filter((r) => r.agrees === true).length) / rs.length) / 10 : null);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const summary = {
  incidents: rows.length,
  rules: perCall.length,
  agreeWithDraftLabels: rows.filter((r) => r.agrees === true).length,
  agreementPct: pct(rows),
  agreementPctClear: pct(rows.filter((r) => r.difficulty === "clear")),
  agreementPctBorderline: pct(rows.filter((r) => r.difficulty === "borderline")),
  drexCalls: perCall.length,
  medianLatencyMsPerCall: median(latencies),
  questionsPerCall: perCall.length ? Math.round((10 * rows.length) / perCall.length) / 10 : 0,
  model: usedModel,
  labelsConfirmedByHuman: false,
  caveat: "labels are an unconfirmed AI draft; this is agreement with draft labels, not accuracy",
};
const experiment = model ? `rule_judge_${model.replace(/[^A-Za-z0-9._-]/g, "_")}` : "rule_judge";
const out = writeResults({ experiment, createdTs: new Date().toISOString(), isMock: false, gitCommit: gitCommit(), simHash: simHash(cfg), config: { model: usedModel, threshold: 0.5, rulesFile: "data/rules/conduct_rules.json", incidentsFile: "data/rules/incidents.template.json" }, rows, summary });

console.log("\nrule   page  n   agreement with draft labels");
for (const [ruleId] of rules) {
  const rs = rows.filter((r) => r.ruleId === ruleId);
  if (rs.length) console.log(`${ruleId.padEnd(6)} ${String(rs[0].rulePage ?? "?").padEnd(4)} ${String(rs.length).padEnd(3)} ${rs.filter((r) => r.agrees).length}/${rs.length} (${pct(rs)}%)`);
}
console.log(`\nTOTAL ${summary.agreeWithDraftLabels}/${summary.incidents} agree with draft labels (${summary.agreementPct}%); clear ${summary.agreementPctClear}%, borderline ${summary.agreementPctBorderline}%`);
console.log(`model ${summary.model}; ${summary.drexCalls} calls, ${summary.questionsPerCall} questions/call, median ${summary.medianLatencyMsPerCall} ms/call`);
console.log(`NOTE: ${summary.caveat}\n`);
console.log("10 largest disagreements (for human review):");
const dis = rows.filter((r) => r.agrees === false).sort((a, b) => Math.abs(b.pYes - (b.expectedViolation ? 1 : 0)) - Math.abs(a.pYes - (a.expectedViolation ? 1 : 0))).slice(0, 10);
for (const r of dis) console.log(`  ${r.id} ${r.ruleId} ${r.difficulty} draft=${r.expectedViolation ? "violation" : "no violation"} pYes=${r.pYes?.toFixed(2)}: ${incidents.find((i) => i.id === r.id).description}`);
console.log(`\n[ruleJudge] wrote ${out}`);
