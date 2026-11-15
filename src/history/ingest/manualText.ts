/**
 * Full text of the official game manual as markdown (one NDI parse, cached forever).
 * The finished job is cached by ndiJob in cache/ndi/manual-parse-2026GameManual.json; when its
 * result is only a preview, the full markdown is fetched once and cached as ...manual-parse-2026GameManual.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../contracts";
import { repoPath } from "../../util/config";
import { ndiJob, ndiPages } from "./ndiClient";

export async function getManualMarkdown(cfg: Config): Promise<{ markdown: string; pages: number; jobId: string; job: any }> {
  const mdFile = repoPath("cache", "ndi", "manual-parse-2026GameManual.md");
  const job = await ndiJob(cfg, "parse", { source: { type: "url", url: cfg.ndi.manualUrls[0], file_name: "2026GameManual.pdf" } }, { purpose: "manual_parse", cacheKey: "manual-parse-2026GameManual" });
  if (job.status !== "succeeded") throw new Error(`NDI parse ${job.status}: ${JSON.stringify(job.error ?? {}).slice(0, 300)}`);
  if (existsSync(mdFile)) return { markdown: readFileSync(mdFile, "utf8"), pages: ndiPages(job), jobId: job.job_id, job };
  const doc = job.result?.document ?? job.result ?? {};
  let markdown: string | undefined = typeof doc.markdown === "string" ? doc.markdown : undefined;
  const link: string | undefined = doc.markdown_url ?? doc.content_url ?? doc.download_url ?? job.result?.content_url ?? job.result?.download_url ?? job.result_url;
  if (!markdown || (doc.truncated || doc.preview) && link) {
    if (!link) throw new Error(`parse result has no markdown and no link; keys: ${Object.keys(doc).join(",")}`);
    const key = process.env[cfg.ndi.apiKeyEnv];
    const url = link.startsWith("http") ? link : `${cfg.ndi.baseUrl}${link}`;
    const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`full content fetch failed: http ${res.status}`);
    const text = await res.text();
    try { const j = JSON.parse(text); markdown = j.markdown ?? j.document?.markdown ?? text; } catch { markdown = text; }
  }
  mkdirSync(path.dirname(mdFile), { recursive: true });
  writeFileSync(mdFile, markdown!);
  return { markdown: markdown!, pages: ndiPages(job), jobId: job.job_id, job };
}
