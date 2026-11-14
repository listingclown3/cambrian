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

/** Parse a JSONL run log; lines that do not match the contract are skipped (a truncated log still lists). */
export function readRunEvents(file: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
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
