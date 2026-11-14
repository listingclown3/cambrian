/**
 * Rule scan: one Intern session that reads rules.json and conduct_rules.json and proposes
 * "rule-created opportunities" (quirks) in the proposals.json contract. Output is untrusted:
 * validated with the same checks, saved to data/lab/rule_scan.json. Run: pnpm lab:rulescan
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig, repoPath } from "../util/config";
import { runLabSession, workspacePath } from "./lab";
import { validateProposals } from "./labRun";
import { buildAgentsMd, buildWorkspace } from "./workspace";

const FOCUS = `

## Focus for THIS run: rule-created opportunities (quirks)
A quirk is a strategy whose value comes from an opportunity the rules create: a protected state, a zone, a timing
window or a scoring exception. Read rules.json and conduct_rules.json closely (fullText and exceptions) and propose
strategies that exploit such an opportunity legally. Use the research notes only for the required sourceUrls: pick the
note whose idea is closest. Do not propose anything that needs opponents to commit fouls.
`;

const cfg = loadConfig();
const dir = workspacePath(cfg);
buildWorkspace(cfg, dir, buildAgentsMd(cfg) + FOCUS);
const notes = JSON.parse(readFileSync(repoPath("data", "research", "notes.json"), "utf8")) as { notes: { sourceUrl: string }[] };
const run = await runLabSession(cfg, "Read AGENTS.md in the working directory and do exactly what it says, including the focus section at the end.", "rule_scan", { maxTurns: 40, timeoutS: 600 });
console.log(`[rulescan] ${run.ok ? "ok" : "FAILED"} ${run.reason} ${run.turns} turns, ${run.system1.judgments} System 1 judgments, ${(run.durationMs / 1000).toFixed(0)} s`);
let raw: unknown = null;
let err: string | null = null;
try {
  raw = JSON.parse(readFileSync(path.join(dir, "proposals.json"), "utf8"));
} catch (e) {
  err = (e as Error).message;
}
const res = err ? { accepted: [], rejected: [{ index: -1, reason: err }] } : validateProposals(raw, new Set(notes.notes.map((n) => n.sourceUrl)));
mkdirSync(repoPath("data", "lab"), { recursive: true });
writeFileSync(
  repoPath("data", "lab", "rule_scan.json"),
  JSON.stringify({ generatedTs: new Date().toISOString(), source: "Intern rule-scan session, validated; not edited by hand", session: { model: run.model, turns: run.turns, system1Judgments: run.system1.judgments, durationS: run.durationMs / 1000, ok: run.ok, reason: run.reason, rejected: res.rejected }, proposals: res.accepted }, null, 2) + "\n",
);
for (const r of res.rejected) console.log(`[rulescan] rejected #${r.index}: ${r.reason}`);
console.log(`[rulescan] accepted ${res.accepted.length}: ${res.accepted.map((p) => p.id).join(", ")}`);
