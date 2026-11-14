/**
 * Offline response cache (owner: P2): wraps a provider so an identical OFFLINE request is
 * answered from disk instead of a fresh call.
 *
 * Key = sha256 of (provider id, model key, variant, stateText, questions). The seed and mode are
 * not part of the key: network providers run at temperature 0 and the request content fully
 * determines what was asked.
 *
 * Rules:
 *   - live requests always bypass the cache (a live match must measure real latency);
 *   - fallback answers are never stored;
 *   - a hit returns the stored answers with meta.cached = true. latencyMs, tokens and costUsd
 *     are those of the ORIGINAL real call (so offline benchmarks keep its measurements); the hit
 *     itself costs nothing and is NOT recorded in the usage ledger, which stays the record of
 *     what was actually spent.
 * Files live under cache/decide/<provider>/<hash>.json (gitignored).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DecisionResponseSchema, type DecisionProvider, type DecisionRequest, type DecisionResponse } from "../contracts";
import { repoPath } from "../util/config";

export interface CacheOptions {
  /** Model the provider will use, or a function resolving it (e.g. ChatDecisionProvider.resolveModel). */
  model: string | (() => Promise<string | null>);
  /** Anything else that changes answers (e.g. "thinking=off"). */
  variant?: string;
  /** Cache directory (default: cache/decide). */
  dir?: string;
}

/** Cache key for a request. */
export function cacheKey(providerId: string, model: string, variant: string, req: Pick<DecisionRequest, "stateText" | "questions">): string {
  return createHash("sha256")
    .update(JSON.stringify([providerId, model, variant, req.stateText, req.questions]))
    .digest("hex");
}

/** Keep a wrapped provider's model information (model / resolveModel) visible through a wrapper. */
export function forwardModel(inner: DecisionProvider): { model?: string; resolveModel?: () => Promise<string | null>; reasoning?: string; splitQuestions?: boolean; warmup?: () => Promise<unknown> } {
  const i = inner as { model?: string; resolveModel?: () => Promise<string | null>; reasoning?: string; splitQuestions?: boolean; warmup?: () => Promise<unknown> };
  return {
    ...(i.model !== undefined ? { model: i.model } : {}),
    ...(i.resolveModel ? { resolveModel: () => i.resolveModel!() } : {}),
    ...(i.reasoning !== undefined ? { reasoning: i.reasoning } : {}),
    ...(i.splitQuestions !== undefined ? { splitQuestions: i.splitQuestions } : {}),
    ...(i.warmup ? { warmup: () => i.warmup!() } : {}),
  };
}

export interface CachedProvider extends DecisionProvider {
  /** Hits and misses so far. */
  readonly stats: { hits: number; misses: number; stored: number };
}

export function cachedProvider(inner: DecisionProvider, opts: CacheOptions): CachedProvider {
  const dir = opts.dir ?? repoPath("cache", "decide");
  const stats = { hits: 0, misses: 0, stored: 0 };
  const variant = opts.variant ?? "";
  const modelKey = async () => (typeof opts.model === "string" ? opts.model : ((await opts.model()) ?? "unresolved"));

  return {
    ...forwardModel(inner),
    id: inner.id,
    stats,
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      if (req.mode !== "offline") return inner.decide(req);
      const key = cacheKey(inner.id, await modelKey(), variant, req);
      const file = path.join(dir, inner.id, `${key}.json`);
      if (existsSync(file)) {
        try {
          const stored = DecisionResponseSchema.parse(JSON.parse(readFileSync(file, "utf8")).response);
          stats.hits += 1;
          return { answers: stored.answers, meta: { ...stored.meta, cached: true } };
        } catch {
          // unreadable entry: fall through and replace it
        }
      }
      stats.misses += 1;
      const res = await inner.decide(req);
      if (!res.meta.fallbackUsed && !res.meta.isMock && !res.meta.cached) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ provider: inner.id, model: res.meta.model, variant, storedTs: new Date().toISOString(), response: res }));
        stats.stored += 1;
      }
      return res;
    },
  };
}
