/**
 * Minimal NDI (Nace document intelligence) client for src/history/ingest (owner: P5).
 *
 *   ndiUpload(cfg, name, content)        -> a workspace_file source for a local file or text
 *   ndiJob(cfg, tool, body, { ... })     -> runs parse | extract | classify | split | ground,
 *                                           waits for it, records it in the usage ledger, and
 *                                           caches the finished job in cache/ndi/<cacheKey>.json
 *
 * API facts (console.nace.ai/docs/ndi, checked 2026-11-14):
 *   - POST {baseUrl}/v1/documents/{tool}?wait_seconds=0..60, Authorization: Bearer <NACE_API_KEY>
 *   - body: { source, ...tool options }. source is one of
 *       { type: "url", url: "https://...", file_name: "x.pdf" }      (file_name needs its extension)
 *       { type: "workspace_file", workspace_id, file_id }            (from ndiUpload)
 *       { type: "parse_result", job_id }                             (reuse a finished parse/extract parse)
 *   - extract options: schema (JSON Schema object; no format/$ref/anyOf), instructions,
 *     citations: { enabled, include_source_text }, page_ranges, parse_mode low|medium|high
 *   - extract result: result.data (values, null when missing) and result.fields[] with
 *     { path: "/field", value, status: found|not_found|ambiguous, confidence, citations[] };
 *     a citation is { location: { kind, page?, ... }, source_text? } and may be absent
 *   - a job is read with GET {baseUrl}/v1/documents/jobs/{job_id}; status is queued | running |
 *     succeeded | failed | cancelled; cost = { total_usd, lines: [{ operation, unit, quantity }] }
 *   - prices per 1,000 pages at low effort: parse $3.50, extract $12 (includes parse)
 *   - supported inputs include pdf, html, markdown, plaintext, csv/xlsx, docx, images
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../contracts";
import { recordUsage } from "../../ledger";
import { repoPath } from "../../util/config";

export type NdiTool = "parse" | "extract" | "classify" | "split" | "ground";
export type NdiSource =
  | { type: "url"; url: string; file_name: string }
  | { type: "workspace_file"; workspace_id: string; file_id: string }
  | { type: "parse_result"; job_id: string };

const TERMINAL = ["succeeded", "failed", "cancelled"];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function auth(cfg: Config): Record<string, string> {
  const key = process.env[cfg.ndi.apiKeyEnv];
  if (!key) throw new Error(`${cfg.ndi.apiKeyEnv} is not set`);
  return { Authorization: `Bearer ${key}` };
}

async function readJob(cfg: Config, jobId: string): Promise<any> {
  const res = await fetch(`${cfg.ndi.baseUrl}/v1/documents/jobs/${jobId}`, { headers: auth(cfg), signal: AbortSignal.timeout(30_000) });
  return res.json();
}

async function waitFor(cfg: Config, job: any, timeoutMs = 600_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (job?.job_id && !TERMINAL.includes(job.status) && Date.now() < deadline) {
    await sleep(3000);
    job = await readJob(cfg, job.job_id);
  }
  return job;
}

/**
 * Upload a file (Buffer) or text (string) to the NDI workspace and return a workspace_file source.
 * `name` is the destination path and must carry the right extension (for example "sheets/s01.csv").
 * Uploading identical content to the same path again returns the existing file.
 */
export async function ndiUpload(cfg: Config, name: string, content: string | Buffer): Promise<Extract<NdiSource, { type: "workspace_file" }>> {
  const grantRes = await fetch(`${cfg.ndi.baseUrl}/v1/documents/upload-grants`, {
    method: "POST",
    headers: { ...auth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ path: name, ttl_seconds: 600 }),
    signal: AbortSignal.timeout(30_000),
  });
  const grant: any = await grantRes.json().catch(() => ({}));
  if (!grantRes.ok || !grant.upload_url) throw new Error(`NDI upload grant failed: http ${grantRes.status} ${JSON.stringify(grant.error ?? grant).slice(0, 300)}`);

  const form = new FormData();
  // `metadata` must be a plain text field, not a file part.
  form.append("metadata", JSON.stringify({ path: name, on_conflict: "new_version" }));
  form.append("file", new Blob([typeof content === "string" ? content : new Uint8Array(content)]), path.basename(name));
  const upRes = await fetch(grant.upload_url, { method: "POST", headers: { "X-Upload-Token": grant.token }, body: form, signal: AbortSignal.timeout(120_000) });
  let job: any = await upRes.json().catch(() => ({}));
  if (!upRes.ok) throw new Error(`NDI upload failed: http ${upRes.status} ${JSON.stringify(job.error ?? job).slice(0, 300)}`);
  job = await waitFor(cfg, job, 120_000);
  const file = job.result?.file ?? job.file;
  if (!file?.file_id) throw new Error(`NDI upload returned no file: ${JSON.stringify(job).slice(0, 300)}`);
  return { type: "workspace_file", workspace_id: file.workspace_id ?? grant.workspace_id, file_id: file.file_id };
}

export interface NdiJobOptions {
  /** Ledger purpose slug, for example "robot_profile_extract". */
  purpose: string;
  /** When set, a finished job is cached in cache/ndi/<cacheKey>.json and reused on the next run. */
  cacheKey?: string;
  /** Ignore the cache and run again. */
  fresh?: boolean;
}

/** Pages billed for a finished job, from its cost lines (0 when NDI reports none). */
export function ndiPages(job: any): number {
  const lines: any[] = job?.cost?.lines ?? [];
  return Math.max(0, ...lines.filter((l) => l.unit === "page").map((l) => Number(l.quantity) || 0));
}

/**
 * Run one NDI job to completion. Returns the finished job (check job.status === "succeeded";
 * the result is in job.result). Never throws for a failed job, only for a refused request.
 * Real (non-cached) jobs are recorded in the usage ledger with NDI's own reported cost.
 */
export async function ndiJob(cfg: Config, tool: NdiTool, body: Record<string, unknown>, options: NdiJobOptions): Promise<any> {
  const cacheDir = repoPath("cache", "ndi");
  const cacheFile = options.cacheKey ? path.join(cacheDir, `${options.cacheKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`) : null;
  if (cacheFile && !options.fresh && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));

  const started = performance.now();
  const res = await fetch(`${cfg.ndi.baseUrl}/v1/documents/${tool}?wait_seconds=${cfg.ndi.waitSeconds}`, {
    method: "POST",
    headers: { ...auth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((cfg.ndi.waitSeconds + 30) * 1000),
  });
  let job: any = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 202) throw new Error(`NDI ${tool} refused: http ${res.status} ${JSON.stringify(job.error ?? job).slice(0, 400)}`);
  job = await waitFor(cfg, job);
  // The charge can settle a moment after the job finishes.
  for (let i = 0; i < 5 && job.status === "succeeded" && !job.cost; i++) {
    await sleep(2000);
    job = await readJob(cfg, job.job_id);
  }
  recordUsage(cfg, {
    tool: "ndi",
    purpose: options.purpose,
    model: `ndi-${tool}`,
    latencyMs: performance.now() - started,
    costUsd: Number(job.cost?.total_usd ?? 0),
    counts: { docs: 1, pages: ndiPages(job) },
  });
  if (cacheFile && job.status === "succeeded") {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(job, null, 2) + "\n");
  }
  return job;
}

/** The first page number in an extract field's citations, or null. */
export function citationPage(field: any): number | null {
  for (const c of field?.citations ?? []) {
    const loc = c?.location ?? {};
    const page = loc.page ?? loc.page_number ?? loc.pages?.[0];
    if (typeof page === "number" && page > 0) return page;
  }
  return null;
}

/** The first citation's source text cut to at most `maxWords` words, or null. */
export function citationQuote(field: any, maxWords = 25): string | null {
  for (const c of field?.citations ?? []) {
    if (typeof c?.source_text === "string" && c.source_text.trim()) return c.source_text.replace(/<[^>]+>/g, " ").trim().split(/\s+/).slice(0, maxWords).join(" ");
  }
  return null;
}
