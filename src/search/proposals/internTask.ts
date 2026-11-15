/**
 * pnpm exec tsx src/search/proposals/internTask.ts --cwd <folder as Intern sees it> --purpose <slug> --task "<text>" [--max-turns N] [--timeout-s N]
 *
 * Runs one Intern session as a general agent (for example a coding task) with the configured
 * System 2 and System 1 models, records it in the usage ledger, and keeps the full event log
 * in runs/intern/<runId>.jsonl (local, gitignored).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, repoPath } from "../../util/config";
import { runLabSession } from "./lab";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cwd = arg("cwd");
const task = arg("task");
const purpose = arg("purpose") ?? "intern_task";
if (!cwd || !task) {
  console.error('usage: internTask.ts --cwd <folder> --purpose <slug> --task "<text>" [--max-turns N] [--timeout-s N]');
  process.exit(2);
}

const cfg = loadConfig();
const logDir = repoPath("runs", "intern");
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${purpose}-${Date.now()}.jsonl`);

const run = await runLabSession(cfg, task, purpose, {
  internCwd: cwd,
  maxTurns: Number(arg("max-turns") ?? 60),
  timeoutS: Number(arg("timeout-s") ?? cfg.lab.timeoutS),
  onEvent: (event) => {
    if (event.type !== "reasoning_delta" && event.type !== "text_delta") appendFileSync(logFile, JSON.stringify(event) + "\n");
    if (event.type === "tool_call_start") console.log(`  turn ${event.turn}: ${event.name} ${JSON.stringify(event.arguments ?? {}).slice(0, 110)}`);
  },
});
console.log(`\n[intern] ${run.ok ? "OK" : "FAILED"} reason=${run.reason} exit=${run.exitCode} model=${run.model}`);
console.log(`[intern] ${run.turns} turns, ${run.toolCalls.length} tool calls, ${run.system1.judgments} System 1 judgments, ${(run.durationMs / 1000).toFixed(0)} s`);
console.log(`[intern] System 2 tokens ${run.system2.inputTokens} in / ${run.system2.outputTokens} out; System 1 tokens ${run.system1.inputTokens} in`);
console.log(`[intern] reply: ${run.text.slice(0, 1200)}`);
if (!run.ok) console.log(`[intern] detail: ${run.detail ?? ""}\n${run.stderr.slice(-800)}`);
console.log(`[intern] event log: ${logFile}`);
process.exit(run.ok ? 0 : 1);
