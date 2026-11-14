/**
 * Run logging and results files (shared utility; Node only).
 *   runs/<runId>/events.jsonl  - one RunEvent per line (gitignored)
 *   results/<experiment>.json  - one ResultsFile per experiment (committed)
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ResultsFileSchema, RunManifestSchema, type Config, type ResultsFile, type RunEvent, type RunEventBody, type RunManifest } from "../contracts";
import { repoPath } from "./config";
import { gitCommit, simHash } from "./provenance";

/** A new run id: "<prefix>-<UTC timestamp>-<4 random hex chars>". */
export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${prefix}-${stamp}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

/** Build the manifest for a run that is starting now. */
export function buildManifest(args: {
  runId: string;
  cfg: Config;
  seeds: { dev: number[]; eval: number[] };
  provider: string;
  model: string;
  isMock: boolean;
}): RunManifest {
  return RunManifestSchema.parse({
    runId: args.runId,
    gitCommit: gitCommit(),
    simHash: simHash(args.cfg),
    config: args.cfg,
    seeds: args.seeds,
    provider: args.provider,
    model: args.model,
    isMock: args.isMock,
    startedTs: new Date().toISOString(),
  });
}

/** Appends RunEvents to runs/<runId>/events.jsonl, stamping ts, runId and seq. */
export class RunLogger {
  readonly file: string;
  private seq = 0;

  constructor(readonly runId: string, dir: string = repoPath("runs", runId)) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "events.jsonl");
  }

  /** Write one event and return the full line that was written. */
  write(body: RunEventBody): RunEvent {
    const event = { ...body, ts: new Date().toISOString(), runId: this.runId, seq: this.seq++ } as RunEvent;
    appendFileSync(this.file, JSON.stringify(event) + "\n");
    return event;
  }
}

/** Validate and write results/<experiment>.json; returns the path. */
export function writeResults(results: ResultsFile, dir: string = repoPath("results")): string {
  const parsed = ResultsFileSchema.parse(results);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${parsed.experiment}.json`);
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
  return file;
}
