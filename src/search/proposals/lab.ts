/**
 * pnpm lab [-- --trial] (owner: P3): the Strategy Lab.
 *
 * System 2 (a model on DeepInfra) runs inside Intern, supervised by System 1 (Drex). It reads
 * the research and proposes strategies; the simulator then tests each one.
 *
 * Working today:
 *   - runLabSession(): runs Intern through src/search/proposals/intern-client.ts and records the session in
 *     the usage ledger (turns, System 1 judgments, tokens, cost)
 *   - parseProposals(): validates what Intern wrote; anything off-contract is rejected
 *   - `pnpm lab -- --trial`: a tiny end-to-end Intern run that proves the tool chain works
 *
 * Still to do (P3), the full `pnpm lab`:
 *   1. Fill cfg.lab.workspaceDir with ONLY copies of data/research/notes.json,
 *      data/rules/rules.json, results/scenarios.json (when present), plus AGENTS.md (the output
 *      contract: the ProposalsFile JSON shape, action names and ALLOWED_PAIRS). Note that Intern
 *      reads SYSTEM2.md only from ~/.intern/, not from the workspace.
 *   2. runLabSession() with the task: propose up to 5 strategies and write proposals.json.
 *   3. parseProposals() on the file; copy accepted ones to data/lab/proposals.json.
 *   4. Simulate each (answer-key rollouts on the relevant families; full matches vs the scripted
 *      baseline on eval seeds) and write results/lab.json with LabResultRow rows.
 *
 * Intern is not a sandbox, so the workspace never contains the repo or .env. On this machine it
 * lives inside WSL, where the Windows drives are not mounted at all.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_LAB_PROPOSALS, ProposalSchema, type Config, type Proposal } from "../../contracts";
import { costFromConfig, recordUsage } from "../../ledger";
import { loadConfig, repoPath } from "../../util/config";
import { runIntern, type InternEvent, type InternRunSummary } from "./intern-client";

/**
 * Validate proposals written by Intern. Returns the valid ones (at most MAX_LAB_PROPOSALS, first
 * come first kept, duplicate ids dropped) and a reason for each one rejected.
 */
export function parseProposals(raw: unknown): { accepted: Proposal[]; rejected: { index: number; reason: string }[] } {
  const accepted: Proposal[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const list = raw && typeof raw === "object" && Array.isArray((raw as { proposals?: unknown }).proposals) ? (raw as { proposals: unknown[] }).proposals : null;
  if (list === null) return { accepted, rejected: [{ index: -1, reason: "expected an object with a `proposals` array" }] };
  list.forEach((item, index) => {
    const parsed = ProposalSchema.safeParse(item);
    if (!parsed.success) rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else if (accepted.some((p) => p.id === parsed.data.id)) rejected.push({ index, reason: `duplicate id ${parsed.data.id}` });
    else if (accepted.length >= MAX_LAB_PROPOSALS) rejected.push({ index, reason: `more than ${MAX_LAB_PROPOSALS} proposals` });
    else accepted.push(parsed.data);
  });
  return { accepted, rejected };
}

/** Host path of the lab workspace (absolute, or relative to the repo root). */
export function workspacePath(cfg: Config): string {
  const dir = cfg.lab.workspaceDir;
  return path.isAbsolute(dir) || dir.startsWith("\\\\") || dir.startsWith("//") ? dir : repoPath(...dir.split("/"));
}

/**
 * Run one Intern session with the configured models and record it in the usage ledger.
 * System 2 cost is computed from config prices when Intern reports none.
 */
export interface LabSessionOptions {
  /** Stop after this many turns. */
  maxTurns?: number;
  /** Folder Intern works in, as Intern sees it; defaults to the configured lab workspace. */
  internCwd?: string;
  /** Wall-clock limit in seconds; defaults to cfg.lab.timeoutS. */
  timeoutS?: number;
  /** Called for every Intern event as it arrives. */
  onEvent?: (event: InternEvent) => void;
}

export async function runLabSession(cfg: Config, task: string, purpose: string, options: LabSessionOptions = {}): Promise<InternRunSummary> {
  const system2 = `${cfg.lab.system2Provider}/${cfg.lab.system2Model}`;
  const run = await runIntern({
    command: cfg.lab.internCommand,
    system2,
    system1: cfg.lab.system1Model ?? undefined,
    internCwd: options.internCwd ?? cfg.lab.internCwd ?? workspacePath(cfg),
    task,
    maxTurns: options.maxTurns,
    timeoutMs: (options.timeoutS ?? cfg.lab.timeoutS) * 1000,
    onEvent: options.onEvent,
  });
  if (run.eventCounts.run_start) {
    const s2Cost = run.system2.costUsd || (costFromConfig(cfg, "deepinfra", cfg.lab.system2Model, run.system2.inputTokens, run.system2.outputTokens) ?? 0);
    const s1Cost = run.system1.costUsd || (costFromConfig(cfg, "drex", "drex-max-v1.1", run.system1.inputTokens, 0) ?? 0);
    recordUsage(cfg, {
      tool: "intern",
      purpose,
      model: `${system2} + ${cfg.lab.system1Model ?? "default"}`,
      inputTokens: run.system2.inputTokens + run.system1.inputTokens,
      outputTokens: run.system2.outputTokens + run.system1.outputTokens,
      latencyMs: run.durationMs,
      costUsd: s2Cost + s1Cost,
      counts: { sessions: 1, system1Judgments: run.system1.judgments, turns: run.turns },
      runId: run.runId,
    });
  }
  return run;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--trial")) {
    const cfg = loadConfig();
    const dir = workspacePath(cfg);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "trial.json");
    rmSync(file, { force: true });
    const run = await runLabSession(cfg, 'Create a file named trial.json in the working directory containing exactly {"ok": true}. Then reply with the single word done.', "trial", { maxTurns: 8 });
    const wrote = existsSync(file) ? readFileSync(file, "utf8").trim() : "(no file)";
    console.log(`[lab] trial: ${run.ok ? "OK" : "FAILED"} reason=${run.reason} exit=${run.exitCode} model=${run.model}`);
    console.log(`[lab]   ${run.turns} turns, ${run.toolCalls.length} tool calls, ${run.system1.judgments} System 1 judgments (${[...new Set(run.system1.decisions.map((d) => d.backend))].join(", ")}), ${(run.durationMs / 1000).toFixed(1)} s`);
    console.log(`[lab]   System 2 tokens ${run.system2.inputTokens} in / ${run.system2.outputTokens} out; System 1 tokens ${run.system1.inputTokens} in`);
    console.log(`[lab]   reply: ${JSON.stringify(run.text)}; workspace file: ${wrote}`);
    if (!run.ok) console.log(`[lab]   detail: ${run.detail ?? ""}\n${run.stderr.slice(-600)}`);
    process.exit(run.ok && wrote.includes('"ok"') ? 0 : 1);
  }
  console.log("usage: pnpm lab [-- --trial]   (the full run is src/search/proposals/main.ts)");
}
