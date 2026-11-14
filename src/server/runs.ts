/**
 * Recorded runs (owner: P4): list and read runs/<runId>/events.jsonl, plus bundled fixtures under
 * src/server/fixtures/<id>/events.jsonl. Fixtures are always reported as source "fixture".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { RunEventSchema, type RunEvent } from "../contracts";
import { repoPath } from "../util/config";
import type { RunListing } from "./protocol";

const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

export function runFile(runId: string, source: "runs" | "fixture"): string | null {
  if (!SAFE_ID.test(runId)) return null;
  const file = source === "runs" ? repoPath("runs", runId, "events.jsonl") : repoPath("src", "server", "fixtures", runId, "events.jsonl");
  return existsSync(file) ? file : null;
}

const cache = new Map<string, { mtimeMs: number; events: RunEvent[] }>();

/**
 * Parse a JSONL run log, cached by file mtime. Only run_start is schema-validated (it carries the config);
 * the other lines are trusted to match the contract, which keeps a 2,400-line run to a few ms instead of seconds.
 */
export function readRunEvents(file: string): RunEvent[] {
  const mtimeMs = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.events;
  const out: RunEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line) as { type?: string };
      if (raw.type === "run_start") {
        const parsed = RunEventSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      } else if (typeof raw.type === "string") out.push(raw as RunEvent);
    } catch {
      /* skip a torn line */
    }
  }
  // A run id that was recorded more than once holds several recordings back to back (the logger
  // appends). Only the last complete one is the run: mixing them interleaves unrelated matches.
  let from = 0;
  for (let i = 0; i < out.length; i++) if (out[i]?.type === "run_start") from = i;
  const last = from > 0 ? out.slice(from) : out;
  cache.set(file, { mtimeMs, events: last });
  return last;
}

function dirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => statSync(`${root}/${n}`).isDirectory());
}

function listing(runId: string, source: "runs" | "fixture"): RunListing | null {
  const file = runFile(runId, source);
  if (!file) return null;
  const events = readRunEvents(file);
  const start = events.find((e) => e.type === "run_start");
  const end = events.find((e) => e.type === "run_end");
  const m = start?.type === "run_start" ? start.manifest : null;
  return {
    runId,
    source,
    isMock: source === "fixture" || events.some((e) => e.isMock),
    provider: m?.provider ?? null,
    model: m?.model ?? null,
    startedTs: m?.startedTs ?? null,
    seed: m ? (m.seeds.eval[0] ?? m.seeds.dev[0] ?? null) : null,
    decisions: events.filter((e) => e.type === "decision").length,
    status: end?.type === "run_end" ? end.status : null,
  };
}

export function listRuns(): RunListing[] {
  const rows = [
    ...dirs(repoPath("runs")).map((id) => listing(id, "runs")),
    ...dirs(repoPath("src", "server", "fixtures")).map((id) => listing(id, "fixture")),
  ];
  return rows.filter((r): r is RunListing => r !== null);
}
