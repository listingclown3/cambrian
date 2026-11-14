/**
 * pnpm research [-- --limit N] (owner: P5): Keenable web research.
 *
 * For each query in cfg.research.queries: search, then fetch each result page as markdown.
 *   - raw pages   -> cfg.research.rawDir/<hash>.json   (RawPage; gitignored: third-party content)
 *   - source list -> data/research/sources.json        (URL, title, query, time, size; committed)
 * Stops at cfg.research.maxRequests (or --limit). Pages already saved are not fetched again, so
 * the command can be re-run to continue. Every real request is recorded in the usage ledger.
 *
 * Page content is untrusted data: it is parsed later for facts, never followed as instructions.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RawPageSchema, type RawPage } from "../contracts";
import { recordUsage } from "../ledger";
import { loadConfig, repoPath } from "../util/config";

const cfg = loadConfig();
const r = cfg.research;
const key = process.env[r.apiKeyEnv];
if (!key) {
  console.error(`[research] ${r.apiKeyEnv} is not set; nothing fetched.`);
  process.exit(1);
}
const limitArg = process.argv.indexOf("--limit");
const maxRequests = Math.min(r.maxRequests, limitArg >= 0 ? Number(process.argv[limitArg + 1]) : r.maxRequests);
const rawDir = repoPath(...r.rawDir.split("/"));
mkdirSync(rawDir, { recursive: true });

const headers: Record<string, string> = { "Content-Type": "application/json", "X-Keenable-Title": r.appTitle, ...(r.authHeader ? { [r.authHeader]: key } : {}) };
const fileFor = (url: string) => path.join(rawDir, `${createHash("sha1").update(url).digest("hex").slice(0, 16)}.json`);
const skipped = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return r.skipDomains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return true;
  }
};

let requests = 0;
let stop = "";
/** One Keenable request with the request cap, 429 back-off and ledger recording. */
async function keenable(purpose: "search" | "fetch", url: string, init: RequestInit): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (requests >= maxRequests) {
      stop = `request cap ${maxRequests} reached`;
      return null;
    }
    requests += 1;
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      console.log(`  ${purpose} failed: ${String(e).slice(0, 80)}`);
      return null;
    }
    const latencyMs = performance.now() - started;
    if (res.status === 429) {
      const waitS = Math.min(30, Number(res.headers.get("retry-after")) || 2);
      console.log(`  429; waiting ${waitS} s`);
      await new Promise((done) => setTimeout(done, waitS * 1000));
      continue;
    }
    if (res.status === 402) {
      stop = "402 insufficient credits";
      return null;
    }
    if (!res.ok) {
      console.log(`  ${purpose} http ${res.status}`);
      return null;
    }
    recordUsage(cfg, { tool: "keenable", purpose, latencyMs, counts: { requests: 1 } });
    return res.json().catch(() => null);
  }
  return null;
}

let saved = 0;
let reused = 0;
for (const query of r.queries) {
  if (stop) break;
  const found = await keenable("search", `${r.baseUrl}${r.searchPath}`, { method: "POST", body: JSON.stringify({ query, max_results: r.maxResultsPerQuery }) });
  const results: { title?: string; url: string }[] = found?.results ?? [];
  console.log(`[research] "${query}" -> ${results.length} results`);
  for (const result of results) {
    if (stop) break;
    if (!result.url || skipped(result.url)) continue;
    const file = fileFor(result.url);
    if (existsSync(file)) {
      reused += 1;
      continue;
    }
    const page = await keenable("fetch", `${r.baseUrl}${r.fetchPath}?url=${encodeURIComponent(result.url)}`, { method: "GET" });
    const content: string = typeof page?.content === "string" ? page.content : "";
    if (content.trim().length < 200) continue; // empty, blocked or paywalled
    const raw: RawPage = RawPageSchema.parse({ url: result.url, fetchedTs: new Date().toISOString(), query, title: result.title ?? page?.title ?? null, content });
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    saved += 1;
  }
}

// Committed source list: metadata only, never page content.
const sources = readdirSync(rawDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => RawPageSchema.parse(JSON.parse(readFileSync(path.join(rawDir, f), "utf8"))))
  .map((p) => ({ url: p.url, title: p.title, query: p.query, fetchedTs: p.fetchedTs, chars: p.content.length }))
  .sort((a, b) => a.url.localeCompare(b.url));
const sourcesFile = repoPath("data", "research", "sources.json");
writeFileSync(sourcesFile, JSON.stringify({ generatedTs: new Date().toISOString(), pages: sources.length, sources }, null, 2) + "\n");

console.log(`[research] ${requests} Keenable requests; ${saved} new pages, ${reused} already saved; ${sources.length} pages kept in total.`);
if (stop) console.log(`[research] stopped early: ${stop}`);
console.log(`[research] wrote ${sourcesFile}`);
