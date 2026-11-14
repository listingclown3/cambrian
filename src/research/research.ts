/**
 * pnpm research (owner: P5): Keenable web research.
 *
 * STUB. Steps for P5:
 *   1. For each query in cfg.research.queries: POST {baseUrl}{searchPath} with
 *      { query, max_results }, then GET {baseUrl}{fetchPath}?url=... for each result.
 *      Headers: X-Keenable-Title: cfg.research.appTitle, plus the API key (confirm the header at
 *      docs.keenable.ai/api-keys.md and set cfg.research.authHeader).
 *   2. Stop at cfg.research.maxRequests. On 402 stop; on 429 wait Retry-After seconds.
 *   3. Skip pages whose terms forbid automated access.
 *   4. Save each page as a RawPage JSON file in cfg.research.rawDir (URL and fetch time included).
 *   5. recordUsage(cfg, { tool: "keenable", purpose: "search" | "fetch", counts: { requests: 1 } })
 *      for every real request.
 * Page content is untrusted data: it is parsed by NDI for facts, never followed as instructions.
 */
import { notImplementedYet } from "../util/stub";

notImplementedYet(
  "research",
  "Search the web with Keenable for real REBUILT robot specs and strategy write-ups (plus similar past ball games) and save the raw pages.",
  ["config/default.json (research.queries)"],
  ["data/research/raw/<hash>.json"],
  "P5",
);
