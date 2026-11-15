/**
 * The real `pnpm lab`: build workspace, run Intern, validate proposals (untrusted), repair once if
 * fewer than 3 are accepted, write data/lab/proposals.json and results/lab.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config, Proposal } from "../../contracts";
import { repoPath } from "../../util/config";
import { gitCommit, simHash } from "../../util/provenance";
import { writeResults } from "../../util/runLog";
import { parseProposals, runLabSession, workspacePath } from "./lab";
import type { InternRunSummary } from "./intern-client";
import { buildWorkspace } from "./workspace";

export interface Rejection {
  index: number;
  reason: string;
}
export interface SessionFacts {
  purpose: string;
  model: string;
  system1Model: string | null;
  turns: number;
  system1Judgments: number;
  durationS: number;
  ok: boolean;
  reason: string;
  accepted: number;
  rejected: Rejection[];
}

/** parseProposals plus one more check: every sourceUrl must be one that exists in notes.json. */
export function validateProposals(raw: unknown, knownUrls: Set<string>): { accepted: Proposal[]; rejected: Rejection[] } {
  const { accepted, rejected } = parseProposals(raw);
  const keep: Proposal[] = [];
  for (const p of accepted) {
    const bad = p.sourceUrls.filter((u) => !knownUrls.has(u));
    if (bad.length > 0) rejected.push({ index: (raw as { proposals: { id?: string }[] }).proposals.findIndex((x) => x?.id === p.id), reason: `sourceUrls not found in notes.json: ${bad.join(", ")}` });
    else keep.push(p);
  }
  return { accepted: keep, rejected };
}

function readProposalsFile(dir: string): { raw: unknown; error?: string } {
  const file = path.join(dir, "proposals.json");
  if (!existsSync(file)) return { raw: null, error: "proposals.json was not written" };
  try {
    return { raw: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { raw: null, error: `proposals.json is not valid JSON: ${(e as Error).message}` };
  }
}

const TASK = "Read AGENTS.md in the working directory and do exactly what it says. It describes the task, the exact output contract for proposals.json, and the steps.";

export async function runLab(cfg: Config): Promise<void> {
  const dir = workspacePath(cfg);
  const files = buildWorkspace(cfg, dir);
  console.log(`[lab] workspace ${dir}: ${files.join(", ")}`);
  const notes = JSON.parse(readFileSync(repoPath("data", "research", "notes.json"), "utf8")) as { notes: { sourceUrl: string }[] };
  const known = new Set(notes.notes.map((n) => n.sourceUrl));

  const sessions: SessionFacts[] = [];
  const log = (run: InternRunSummary, purpose: string) =>
    console.log(`[lab] ${purpose}: ${run.ok ? "ok" : "FAILED"} reason=${run.reason} ${run.turns} turns, ${run.system1.judgments} System 1 judgments, ${(run.durationMs / 1000).toFixed(0)} s, model ${run.model}`);
  const facts = (run: InternRunSummary, purpose: string, accepted: number, rejected: Rejection[]): SessionFacts => ({
    purpose,
    model: run.model ?? `${cfg.lab.system2Provider}/${cfg.lab.system2Model}`,
    system1Model: cfg.lab.system1Model ?? null,
    turns: run.turns,
    system1Judgments: run.system1.judgments,
    durationS: Math.round(run.durationMs / 100) / 10,
    ok: run.ok,
    reason: run.reason,
    accepted,
    rejected,
  });
  const onEvent = (e: { type?: string }) => process.stdout.write(e.type === "turn_start" ? "." : "");

  const run1 = await runLabSession(cfg, TASK, "strategy_lab", { maxTurns: 40, timeoutS: 600, onEvent });
  console.log();
  log(run1, "strategy_lab");
  let read = readProposalsFile(dir);
  let result = read.error ? { accepted: [] as Proposal[], rejected: [{ index: -1, reason: read.error }] } : validateProposals(read.raw, known);
  sessions.push(facts(run1, "strategy_lab", result.accepted.length, result.rejected));
  for (const r of result.rejected) console.log(`[lab]   rejected #${r.index}: ${r.reason}`);

  if (result.accepted.length < 3) {
    const problems = result.rejected.map((r) => `- proposal #${r.index}: ${r.reason}`).join("\n");
    const repairTask = `${TASK}\n\nREPAIR: a previous proposals.json in this folder was checked and ${result.accepted.length} proposal(s) were valid. These problems were found:\n${problems}\n\nRewrite proposals.json so that it has 3 to 5 proposals that all follow AGENTS.md exactly (keep the valid ones, fix or replace the others), then validate it by reading it back.`;
    const run2 = await runLabSession(cfg, repairTask, "strategy_lab_repair", { maxTurns: 40, timeoutS: 600, onEvent });
    console.log();
    log(run2, "strategy_lab_repair");
    read = readProposalsFile(dir);
    result = read.error ? { accepted: [] as Proposal[], rejected: [{ index: -1, reason: read.error }] } : validateProposals(read.raw, known);
    sessions.push(facts(run2, "strategy_lab_repair", result.accepted.length, result.rejected));
    for (const r of result.rejected) console.log(`[lab]   rejected after repair #${r.index}: ${r.reason}`);
  }

  mkdirSync(repoPath("data", "lab"), { recursive: true });
  writeFileSync(
    repoPath("data", "lab", "proposals.json"),
    JSON.stringify({ generatedTs: new Date().toISOString(), source: "Intern session(s), validated with parseProposals; not edited by hand", sessions, proposals: result.accepted }, null, 2) + "\n",
  );
  const s1 = sessions.reduce((a, s) => a + s.system1Judgments, 0);
  writeResults({
    experiment: "lab",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { lab: cfg.lab },
    rows: result.accepted.map((p) => ({ proposalId: p.id, marginVsBaseline: null, ci95: null, nMatches: null, scenarioValue: null, beatsBaseline: null })),
    summary: {
      lab_proposals_total: result.accepted.length,
      lab_proposals_beating_baseline: null,
      sessions: sessions.length,
      system1Judgments: s1,
      system2Model: `${cfg.lab.system2Provider}/${cfg.lab.system2Model}`,
      system1Model: cfg.lab.system1Model ?? null,
      rejected: sessions[sessions.length - 1]!.rejected,
      simulated: false,
    },
  });
  console.log(`[lab] accepted ${result.accepted.length} proposals -> data/lab/proposals.json, results/lab.json`);
  process.exit(result.accepted.length > 0 ? 0 : 1);
}
