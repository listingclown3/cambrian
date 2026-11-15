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
import { RawPageSchema, type RawPage } from "../../contracts";
import { keenableProvider } from "../../providers/keenable";
import type { SearchProvider } from "../../providers/roles";
import { loadConfig, repoPath } from "../../util/config";

const cfg = loadConfig();
const r = cfg.research;
const provider: SearchProvider | null = keenableProvider(cfg);
if (!provider) {
  console.error(`[research] ${r.apiKeyEnv} is not set; nothing fetched.`);
  process.exit(1);
}
const limitArg = process.argv.indexOf("--limit");
const maxRequests = Math.min(r.maxRequests, limitArg >= 0 ? Number(process.argv[limitArg + 1]) : r.maxRequests);
const rawDir = repoPath(...r.rawDir.split("/"));
mkdirSync(rawDir, { recursive: true });

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
/** Count a request against the cap; false (and a stop reason) once the cap is reached. */
const allowed = () => {
  if (requests >= maxRequests) {
    stop = `request cap ${maxRequests} reached`;
    return false;
  }
  requests += 1;
  return true;
};

let saved = 0;
let reused = 0;
for (const query of r.queries) {
  if (stop || !allowed()) break;
  const found = await provider.search(query, r.maxResultsPerQuery);
  if ("stop" in found) {
    stop = found.stop;
    break;
  }
  console.log(`[research] "${query}" -> ${found.length} results`);
  for (const result of found) {
    if (stop) break;
    if (skipped(result.url)) continue;
    const file = fileFor(result.url);
    if (existsSync(file)) {
      reused += 1;
      continue;
    }
    if (!allowed()) break;
    const page = await provider.fetch(result.url);
    if (page && "stop" in page) {
      stop = page.stop;
      break;
    }
    const content = page?.content ?? "";
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

console.log(`[research] ${requests} ${provider.id} requests; ${saved} new pages, ${reused} already saved; ${sources.length} pages kept in total.`);
if (stop) console.log(`[research] stopped early: ${stop}`);
console.log(`[research] wrote ${sourcesFile}`);
