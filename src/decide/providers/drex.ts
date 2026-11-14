/**
 * drex (System 1, owner: P2): Nace's closed-choice decision model.
 *
 * POST cfg.providers.byId.drex.endpoint with { model, state, questions }; the mapping from our
 * DecisionRequest is the table at the top of src/contracts/decide.ts. One call answers every
 * question in the request (up to 512), which is how the controller batches several robots.
 *
 * Model: cfg model (drex-v2.0, about 48 ms evaluation) unless the factory is given another one,
 * for example drexProvider(cfg, { model: "drex-latest" }) or getProvider("drex:drex-latest").
 * meta.model is the model the service REPORTS serving (drex-latest is served as drex-max-v1.1).
 *
 * Never throws. Any failure returns fallback answers with meta.fallbackUsed = true and
 * meta.error set. An answer whose label is not one of the offered labels is replaced by the
 * fallback for that question, and the response is flagged.
 */
import { costFromConfig } from "../../ledger";
import type { Answer, Config, DecisionProvider, DecisionRequest, DecisionResponse, Question } from "../../contracts";
import { defaultAnswer, fallbackResponse } from "./shared";
import { repoPath } from "../../util/config";
import { acquireShared } from "./sharedLimit";
import { BLOCKED_BY_CHECKPOINT, HttpError, authHeaders, breakerState, estimateCostUsd, limiterFor, recordRealCall, requestJson, retriesFor, spendCapBlock, type ProviderDeps } from "./http";

export interface DrexOptions extends ProviderDeps {
  /** Drex model id to request (default: cfg.providers.byId.drex.model). */
  model?: string;
  /** Per-request timeout override, milliseconds (default: config timeoutMs). */
  timeoutMs?: number;
  /**
   * Which official host serves the model: "console" (default, console.nace.ai) or a key of
   * cfg.providers.byId.drex.hosts, e.g. "deepinfra" (DeepInfra's Decisions API, model ids
   * nace-ai/...). meta.model then carries the host: "nace-ai/drex-v2.0 @deepinfra".
   */
  host?: string;
}

/** The Drex wire body for a request. Exported so tests and tools can inspect it. */
export function drexBody(model: string, req: DecisionRequest): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const q of req.questions) {
    if (q.kind === "choice") questions[q.id] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries((q.options ?? []).map((o) => [o.label, o.description])) };
    else if (q.kind === "noul") questions[q.id] = { type: "noul", instructions: q.instructions };
    else questions[q.id] = { type: "score", instructions: q.instructions, criteria: q.levels ?? [] };
  }
  return { model, state: req.stateText, questions };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** Normalise a probability map so it sums to 1 (Drex rounds); null when unusable. */
function normalise(p: Record<string, number>): Record<string, number> | null {
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
}

/** Turn one Drex answer into ours. Returns an error string when the answer is unusable. */
export function parseDrexAnswer(q: Question, raw: any): Answer | string {
  if (!raw || typeof raw !== "object") return `no answer for question ${q.id}`;
  const confidence = num(raw.confidence);
  const conf = confidence === undefined ? {} : { confidence: clamp01(confidence) };
  switch (q.kind) {
    case "choice": {
      const labels = (q.options ?? []).map((o) => o.label);
      const chosen = raw.choice;
      if (typeof chosen !== "string" || !labels.includes(chosen)) return `question ${q.id}: chose ${JSON.stringify(chosen)}, which is not an offered label`;
      let probabilities: Record<string, number> | null = null;
      if (raw.probabilities && typeof raw.probabilities === "object") {
        const p: Record<string, number> = {};
        for (const l of labels) p[l] = Math.max(0, num(raw.probabilities[l]) ?? 0);
        probabilities = normalise(p);
      }
      return { chosen, probabilities, ...conf };
    }
    case "noul": {
      const p = num(raw.noul) ?? num(raw.probability);
      if (p === undefined) return `question ${q.id}: no noul probability`;
      return { probability: clamp01(p), ...conf };
    }
    case "score": {
      const levels = q.levels ?? [];
      const probs = raw.probabilities;
      let weights: number[] | null = null;
      if (Array.isArray(probs)) weights = levels.map((_, i) => Math.max(0, num(probs[i]) ?? 0));
      else if (probs && typeof probs === "object") {
        weights = levels.map((level, i) => Math.max(0, num(probs[level]) ?? num(probs[String(i)]) ?? 0));
      }
      const total = weights?.reduce((a, b) => a + b, 0) ?? 0;
      if (weights && total > 0) {
        const probabilities = Object.fromEntries(weights.map((w, i) => [String(i), w / total]));
        const expectedScore = weights.reduce((s, w, i) => s + (i * w) / total, 0);
        return { expectedScore, probabilities, ...conf };
      }
      const score = num(raw.score) ?? (typeof raw.score === "string" ? levels.indexOf(raw.score) : undefined);
      if (score === undefined || score < 0) return `question ${q.id}: no usable score`;
      return { expectedScore: score, ...conf };
    }
  }
}

/** Server-side evaluation time per successful Drex call (evaluation_time_ms, or timings), for diagnostics. */
export const drexServerTimings: { model: string; latencyMs: number; evaluationMs: number | null }[] = [];

export function drexProvider(cfg: Config, opts: DrexOptions = {}): DecisionProvider & { readonly model: string; readonly host: string; warmup(): Promise<DecisionResponse> } {
  const p = cfg.providers.byId.drex;
  const model = opts.model ?? p.model ?? "drex-v2.0";
  const env = opts.env ?? process.env;
  const hostName = opts.host && opts.host !== "console" ? opts.host : null;
  const host = hostName ? p.hosts?.[hostName] : undefined;
  if (hostName && !host) throw new Error(`unknown drex host "${hostName}" (config providers.byId.drex.hosts)`);
  // Connection for the chosen host. Numbers from different hosts are never mixed: the host is in
  // meta.model, the ledger model string, the limiter bucket and (via the registry) the cache key.
  const conn = host
    ? {
        endpoint: host.endpoint as string | null,
        apiKeyEnv: host.apiKeyEnv as string | null,
        auth: { ...p, authHeader: host.authHeader, authScheme: host.authScheme, extraHeaders: {} },
        wireModel: host.models[model] ?? model,
        timeoutMs: host.timeoutMs ?? p.timeoutMs,
        shared: host.sharedRateLimit,
        bucket: `drex-${hostName}`,
        suffix: ` @${hostName}`,
      }
    : { endpoint: p.endpoint, apiKeyEnv: p.apiKeyEnv, auth: p, wireModel: model, timeoutMs: p.timeoutMs, shared: p.sharedRateLimit, bucket: "drex", suffix: "" };
  const label = `${model}${conn.suffix}`;
  const limit = limiterFor("drex", p);

  async function call(req: DecisionRequest, enqueuedMs: number): Promise<DecisionResponse> {
    const started = performance.now();
    const queuedMs = started - enqueuedMs;
    const key = env[conn.apiKeyEnv ?? ""];
    const endpoint = conn.endpoint;
    if (!endpoint || !key) return fallbackResponse(req, "drex", label, started, `${conn.apiKeyEnv ?? "drex api key"} is not set`);
    const body = drexBody(conn.wireModel, req);
    const blocked = spendCapBlock(cfg, "drex", estimateCostUsd(cfg, "drex", conn.wireModel, JSON.stringify(body).length, 0));
    if (blocked) return fallbackResponse(req, "drex", label, started, blocked);
    const breaker = breakerState(endpoint);
    if (breaker.open) {
      return fallbackResponse(req, "drex", label, started, `drex ${label}: ${BLOCKED_BY_CHECKPOINT}: circuit open after ${breaker.consecutive} checkpoint responses; next probe at ${new Date(breaker.openUntilMs).toISOString()} (request not sent)`);
    }

    // Machine-wide pacing shared with every other process calling Drex (config sharedRateLimit).
    // The wait counts in latencyMs: a robot waiting for a slot is waiting for its answer.
    const timeoutMs = opts.timeoutMs ?? conn.timeoutMs;
    let release: (() => void) | null = null;
    if (conn.shared && opts.sharedLimitDir !== false) {
      const maxWait = req.mode === "live" ? timeoutMs : 120_000;
      release = await acquireShared({ dir: opts.sharedLimitDir ?? repoPath("cache", "ratelimit", conn.bucket), ...conn.shared }, maxWait, timeoutMs * (1 + retriesFor(p, req.mode)) + 5_000);
      if (!release) return fallbackResponse(req, "drex", label, started, `drex ${label}: rate_limited_locally: no shared Drex slot within ${maxWait} ms (request not sent)`);
    }

    let json: any;
    try {
      ({ json } = await requestJson(endpoint, { headers: authHeaders(conn.auth, key), body }, { timeoutMs, retries: retriesFor(p, req.mode), deps: opts, queuedMs }));
    } catch (e) {
      release?.();
      // The request was sent, so it may have been billed: record it (tokens unknown = 0).
      // A call refused locally (open circuit breaker, limiter) never left: not recorded.
      if (!(e instanceof HttpError && !e.sent)) recordRealCall(cfg, "drex", opts, { tool: "drex", model: label, latencyMs: performance.now() - started, costUsd: 0, counts: { questions: req.questions.length }, purpose: `${opts.purpose ?? "decision"}_failed` });
      return fallbackResponse(req, "drex", label, started, `drex ${label}: ${(e as Error).message}`);
    }
    release?.();
    const latencyMs = performance.now() - started;
    const servedId = typeof json?.model === "string" ? json.model : conn.wireModel;
    const served = `${servedId}${conn.suffix}`;
    const evalMs = num(json?.evaluation_time_ms) ?? num(json?.timings?.evaluation_time_ms) ?? num(json?.timings?.server_ms) ?? null;
    if (drexServerTimings.length > 10_000) drexServerTimings.shift();
    drexServerTimings.push({ model: served, latencyMs, evaluationMs: evalMs });
    const inputTokens = Math.max(0, Math.round(num(json?.usage?.input_tokens) ?? 0));
    const outputTokens = Math.max(0, Math.round(num(json?.usage?.output_tokens) ?? 0));
    // A host-reported charge wins; else config prices for the exact served id on that host.
    const reported = num(json?.usage?.estimated_cost);
    const costUsd = reported !== undefined && reported >= 0 ? reported : (costFromConfig(cfg, "drex", servedId, inputTokens, outputTokens) ?? 0);
    recordRealCall(cfg, "drex", opts, { tool: "drex", model: served, inputTokens, outputTokens, latencyMs, costUsd, counts: { questions: req.questions.length } });

    const answers: Record<string, Answer> = {};
    const errors: string[] = [];
    for (const q of req.questions) {
      const parsed = parseDrexAnswer(q, json?.answers?.[q.id]);
      if (typeof parsed === "string") {
        errors.push(parsed);
        answers[q.id] = defaultAnswer(q);
      } else answers[q.id] = parsed;
    }
    return {
      answers,
      meta: {
        provider: "drex",
        model: served,
        latencyMs,
        inputTokens,
        outputTokens,
        costUsd,
        fallbackUsed: errors.length > 0,
        cached: false,
        error: errors.length > 0 ? `drex ${served}: ${errors.length} of ${req.questions.length} answers unusable (fallback used for those): ${errors.slice(0, 3).join("; ")}` : null,
        isMock: false,
      },
    };
  }

  return {
    id: "drex",
    /** The model id requested, with the host for non-console hosts (the served id is in meta.model). */
    model: label,
    /** "console" or the configured host name. */
    host: hostName ?? "console",
    // Latency is measured inside call(), i.e. from when the request is actually sent, not from
    // when it entered the concurrency queue.
    decide: (req) => {
      const enqueuedMs = performance.now();
      return limit(() => call(req, enqueuedMs));
    },
    /**
     * One tiny real call before a match, so the TLS connection is open (and kept alive) when
     * the first in-match decision is made. Measured 2026-11-14: the first call of a process
     * took over 2 s (cold connection) and timed out. Recorded in the ledger as purpose "warmup".
     */
    async warmup(): Promise<DecisionResponse> {
      return drexProvider(cfg, { ...opts, purpose: "warmup", timeoutMs: Math.max(opts.timeoutMs ?? p.timeoutMs, 10_000) }).decide({
        stateText: "Warm-up call before a match.",
        questions: [{ id: "ready", kind: "noul", instructions: "Is this a warm-up call?" }],
        seed: 0,
        mode: "live",
      });
    },
  };
}
