/**
 * A small, dependency-free Node client for Intern (github.com/nace-ai/intern) run headless.
 *
 * It starts `intern -p --json` as a subprocess, sends the task on stdin, parses the JSON event
 * stream (one event per line), and returns a summary: turns, System 2 token usage, and every
 * System 1 supervisor judgment.
 *
 * Self-contained on purpose: it imports nothing but Node built-ins, so it can be copied into
 * another project as-is. Event shapes follow `intern schema` (protocol_version 2, Intern 0.30).
 *
 * Example:
 *   const run = await runIntern({
 *     command: ["intern"],                       // or ["wsl.exe", "-e", ...] on Windows
 *     system2: "deepinfra/Qwen/Qwen3.8-27B",
 *     system1: "drex-latest",
 *     internCwd: "/home/me/workspace",
 *     task: "Read notes.json and write proposals.json.",
 *   });
 *   console.log(run.reason, run.turns, run.system1.judgments, run.text);
 */
import { spawn } from "node:child_process";

/** One line of Intern's `--json` stream. Every event has a `type`; other fields depend on it. */
export interface InternEvent {
  type: string;
  timestamp?: number;
  turn?: number;
  [key: string]: unknown;
}

export interface InternRunOptions {
  /** The Intern executable and any leading arguments, for example ["intern"]. */
  command: string[];
  /** Agent model as provider/model, passed to --system2. */
  system2: string;
  /** Decision model passed to --system1 (for example "drex-latest"); omit for Intern's default. */
  system1?: string;
  /** The task. Sent on stdin, so it needs no shell quoting. */
  task: string;
  /** Working directory for Intern's tools (--cwd), as a path Intern itself can see. */
  internCwd?: string;
  /** Working directory of the subprocess on the host. */
  processCwd?: string;
  /** Stop after this many turns (--max-turns). */
  maxTurns?: number;
  /** Kill the run after this many milliseconds. Default 10 minutes. */
  timeoutMs?: number;
  /** Keep the journal in memory only (--no-session). Default true. */
  noSession?: boolean;
  /** Mount no memory drive (--no-memory). Default true. */
  noMemory?: boolean;
  /** Extra arguments placed before the task. */
  extraArgs?: string[];
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Called for every event as it arrives. */
  onEvent?: (event: InternEvent) => void;
}

/** One System 1 call made while supervising the run. */
export interface InternDecision {
  turn: number | null;
  /** Why System 1 was asked (for example "supervise"). */
  purpose: string;
  /** Which decision backend answered (for example "decisions-api:drex-latest"). */
  backend: string;
  /** Number of questions in the call. */
  questions: number;
  ok: boolean;
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd: number;
  error: string | null;
  /** The answers, keyed by question id, as Intern reported them. */
  answers: Record<string, unknown>;
}

export interface InternRunSummary {
  /** True when the process exited 0 and the run ended with reason "completed". */
  ok: boolean;
  exitCode: number | null;
  /** run_end.reason: "completed", "max_turns", an error reason, or "no_run_end" / "timeout". */
  reason: string;
  detail: string | null;
  runId: string | null;
  sessionId: string | null;
  /** The System 2 model Intern reported at run_start. */
  model: string | null;
  turns: number;
  /** Wall-clock milliseconds for the whole subprocess. */
  durationMs: number;
  /** The agent's final text reply. */
  text: string;
  /** Tool calls the agent made: name and status, in order. */
  toolCalls: { name: string; status: string; durationMs: number }[];
  /** System 2 (agent model) usage as reported at run_end. */
  system2: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; costUsd: number };
  /** System 1 (decision model) usage, totalled over every decision event. */
  system1: { calls: number; judgments: number; inputTokens: number; outputTokens: number; costUsd: number; errors: number; decisions: InternDecision[] };
  /** How many events of each type arrived. */
  eventCounts: Record<string, number>;
  /** Lines on stdout that were not JSON, and everything on stderr (trimmed to the last 4000 chars). */
  stderr: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parse `--json` output into events. Lines that are not JSON objects with a `type` are skipped. */
export function parseInternEvents(stdout: string): InternEvent[] {
  const events: InternEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as InternEvent;
      if (parsed && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // not an event line
    }
  }
  return events;
}

/** Reduce an event list to a run summary. Pure: usable on a saved event log. */
export function summarizeInternEvents(events: readonly InternEvent[]): Omit<InternRunSummary, "exitCode" | "durationMs" | "stderr" | "ok"> {
  const eventCounts: Record<string, number> = {};
  const decisions: InternDecision[] = [];
  const toolCalls: InternRunSummary["toolCalls"] = [];
  const textByTurn = new Map<number, string>();
  let start: InternEvent | undefined;
  let end: InternEvent | undefined;
  let turns = 0;

  for (const e of events) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    switch (e.type) {
      case "run_start":
        start = e;
        break;
      case "run_end":
        end = e;
        break;
      case "turn_start":
        turns = Math.max(turns, num(e.turn));
        break;
      case "text_delta":
        textByTurn.set(num(e.turn), (textByTurn.get(num(e.turn)) ?? "") + (str(e.text) ?? ""));
        break;
      case "tool_call_end":
        toolCalls.push({ name: str(e.name) ?? "?", status: str(e.status) ?? "?", durationMs: num(e.duration_ms) });
        break;
      case "decision":
        decisions.push({
          turn: typeof e.turn === "number" ? e.turn : null,
          purpose: str(e.purpose) ?? "?",
          backend: str(e.backend) ?? "?",
          questions: num(e.questions),
          ok: e.ok === true,
          cached: e.cached === true,
          inputTokens: num(e.input_tokens),
          outputTokens: num(e.output_tokens),
          durationMs: num(e.duration_ms),
          costUsd: num(e.cost_usd),
          error: str(e.error),
          answers: (e.answers as Record<string, unknown>) ?? {},
        });
        break;
    }
  }

  const usage = (end?.agent_usage ?? end?.usage ?? {}) as Record<string, unknown>;
  const real = decisions.filter((d) => !d.cached);
  const lastTurnWithText = [...textByTurn.keys()].sort((a, b) => b - a)[0];
  return {
    reason: str(end?.reason) ?? "no_run_end",
    detail: str(end?.detail),
    runId: str(end?.run_id) ?? str(start?.run_id),
    sessionId: str(start?.session_id),
    model: str(start?.model),
    turns: num(end?.turns) || turns,
    text: (lastTurnWithText === undefined ? "" : textByTurn.get(lastTurnWithText)!).trim(),
    toolCalls,
    system2: {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_tokens),
      reasoningTokens: num(usage.reasoning_tokens),
      costUsd: num(usage.cost_usd),
    },
    system1: {
      calls: real.length,
      judgments: real.reduce((sum, d) => sum + d.questions, 0),
      inputTokens: real.reduce((sum, d) => sum + d.inputTokens, 0),
      outputTokens: real.reduce((sum, d) => sum + d.outputTokens, 0),
      costUsd: real.reduce((sum, d) => sum + d.costUsd, 0),
      errors: decisions.filter((d) => !d.ok).length,
      decisions,
    },
    eventCounts,
  };
}

/** Build the argument list for a headless run (everything after the command itself). */
export function internArgs(options: InternRunOptions): string[] {
  const args = ["-p", "--json", "--system2", options.system2];
  if (options.system1) args.push("--system1", options.system1);
  if (options.internCwd) args.push("--cwd", options.internCwd);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  if (options.noSession !== false) args.push("--no-session");
  if (options.noMemory !== false) args.push("--no-memory");
  return [...args, ...(options.extraArgs ?? [])];
}

/** Run one headless Intern session and summarise it. Never throws for a failed run: check `ok`. */
export function runIntern(options: InternRunOptions): Promise<InternRunSummary> {
  const [exe, ...lead] = options.command;
  if (!exe) return Promise.reject(new Error("runIntern: command is empty"));
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 600_000;

  return new Promise((resolve) => {
    const child = spawn(exe, [...lead, ...internArgs(options)], {
      cwd: options.processCwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const events: InternEvent[] = [];
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const takeLines = (flush: boolean) => {
      const lines = buffer.split("\n");
      buffer = flush ? "" : (lines.pop() ?? "");
      for (const event of parseInternEvents(lines.join("\n"))) {
        events.push(event);
        options.onEvent?.(event);
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk.replaceAll("\u0000", "");
      takeLines(false);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk.replaceAll("\u0000", "")).slice(-4000);
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      clearTimeout(timer);
      takeLines(true);
      const summary = summarizeInternEvents(events);
      const reason = timedOut ? "timeout" : spawnError ? "spawn_error" : summary.reason;
      resolve({
        ...summary,
        reason,
        detail: spawnError ?? summary.detail,
        ok: exitCode === 0 && reason === "completed",
        exitCode,
        durationMs: Date.now() - started,
        stderr: stderr.trim(),
      });
    };
    child.on("error", (error) => finish(null, String(error)));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(options.task);
  });
}
