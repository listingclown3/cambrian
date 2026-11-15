/**
 * Keenable web search as a SearchProvider. Auth: the key in cfg.research.authHeader.
 * On 402 the provider reports a stop; on 429 it waits Retry-After (at most 30 s) and retries.
 * Every successful request is recorded in the usage ledger.
 */
import type { Config } from "../contracts";
import { recordUsage } from "../ledger";
import type { FetchedPage, SearchHit, SearchProvider } from "./roles";

export interface KeenableDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  record?: typeof recordUsage;
  sleep?: (ms: number) => Promise<void>;
}

/** null when the key is not set. */
export function keenableProvider(cfg: Config, deps: KeenableDeps = {}): SearchProvider | null {
  const r = cfg.research;
  const key = (deps.env ?? process.env)[r.apiKeyEnv];
  if (!key) return null;
  const doFetch = deps.fetch ?? fetch;
  const record = deps.record ?? recordUsage;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Keenable-Title": r.appTitle, ...(r.authHeader ? { [r.authHeader]: key } : {}) };

  async function call(purpose: "search" | "fetch", url: string, init: RequestInit): Promise<any | { stop: string } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      let res: Response;
      try {
        res = await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(45_000) });
      } catch {
        return null;
      }
      if (res.status === 429) {
        await sleep(Math.min(30, Number(res.headers.get("retry-after")) || 2) * 1000);
        continue;
      }
      if (res.status === 402) return { stop: "402 insufficient credits" };
      if (!res.ok) return null;
      record(cfg, { tool: "keenable", purpose, latencyMs: performance.now() - started, counts: { requests: 1 } });
      return res.json().catch(() => null);
    }
    return null;
  }

  return {
    id: "keenable",
    async search(query: string, maxResults: number): Promise<SearchHit[] | { stop: string }> {
      const found = await call("search", `${r.baseUrl}${r.searchPath}`, { method: "POST", body: JSON.stringify({ query, max_results: maxResults }) });
      if (found && "stop" in found) return found;
      return ((found?.results ?? []) as { url?: string; title?: string }[]).filter((x) => x.url).map((x) => ({ url: x.url!, title: x.title ?? null }));
    },
    async fetch(url: string): Promise<FetchedPage | null | { stop: string }> {
      const page = await call("fetch", `${r.baseUrl}${r.fetchPath}?url=${encodeURIComponent(url)}`, { method: "GET" });
      if (page && "stop" in page) return page;
      if (typeof page?.content !== "string") return null;
      return { url, title: page.title ?? null, content: page.content };
    },
  };
}
