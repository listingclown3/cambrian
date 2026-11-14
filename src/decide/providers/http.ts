/**
 * HTTP plumbing shared by the network providers (owner: P2): auth headers, timeouts, retries,
 * key redaction, spend tracking and the injectable seams tests use instead of the network.
 *
 * Retries happen only in offline mode (a live match must never wait on a retry). Retryable
 * statuses are 429/500/502/503/504/529 and network errors; 4xx such as 422 are never retried.
 * Retry-After-Ms (or Retry-After, seconds) is honoured when the server sends it.
 */
import pLimit from "p-limit";
import type { Config, DecisionRequest, ProviderConfig, ProviderId } from "../../contracts";
import { recordUsage, type UsageInput } from "../../ledger";

/** Seams for tests and offline tools. Production code passes nothing. */
export interface ProviderDeps {
  /** fetch implementation (default: global fetch). */
  fetch?: typeof fetch;
  /** Ledger writer (default: recordUsage against cfg.ledger.file). */
  record?: (cfg: Config, input: UsageInput) => unknown;
  /** Environment to read API keys from (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Ledger purpose slug for calls made by this provider instance (default "decision"). */
  purpose?: string;
  /** Run id stamped on ledger entries. */
  runId?: string | null;
  /** Sleep used between retries (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529]);

/** Replace every secret-looking env value in a string, collapse whitespace and cap the length. */
export function redact(text: string, env: Record<string, string | undefined> = process.env, max = 300): string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET/i.test(name) && value && value.length >= 8)
    .map(([, value]) => value!);
  return secrets
    .reduce((t, s) => t.replaceAll(s, "<redacted>"), text)
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, "Bearer <redacted>")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

/** Headers for a provider: content type, extra headers and the auth header. */
export function authHeaders(p: ProviderConfig, key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...p.extraHeaders,
    ...(p.authHeader ? { [p.authHeader]: p.authScheme ? `${p.authScheme} ${key}` : key } : {}),
  };
}

/** Result of one HTTP exchange (after retries). */
export interface HttpResult {
  status: number;
  json: any;
  /** Attempts made (1 = no retry). */
  attempts: number;
}

/** Error carrying an HTTP status, so callers can tell access errors from transport failures. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(res: Response | null, attempt: number): number {
  const ms = Number(res?.headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 10_000);
  const s = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, 10_000);
  return Math.min(250 * 2 ** attempt, 4_000);
}

// -- per-attempt diagnostics (in memory, bounded; no request headers are kept) --

/** One HTTP attempt, for latency/timeout diagnosis. */
export interface CallStat {
  /** Request origin + path (no query, no headers). */
  target: string;
  /** Wall-clock start (performance.now()). */
  startedMs: number;
  /** Milliseconds the call waited in the provider's concurrency queue before this attempt (first attempt only). */
  queuedMs: number;
  /** Milliseconds until response headers arrived (null on network error/timeout). */
  headersMs: number | null;
  /** Milliseconds for the whole attempt, body included. */
  totalMs: number;
  /** HTTP status, or null for a network error or timeout. */
  status: number | null;
  /** Requests to the same origin in flight when this one started (this one included). */
  inFlight: number;
  /** Retry-After-Ms / Retry-After / x-ratelimit-* response headers, when present. */
  rateHeaders: Record<string, string>;
  /** Error text (redacted), or null. */
  error: string | null;
}

const MAX_STATS = 20_000;
export const callStats: CallStat[] = [];
const inFlightByOrigin = new Map<string, number>();

/**
 * POST (or GET when body is undefined) JSON with a per-attempt timeout. Retries only when
 * `retries` > 0. Returns parsed JSON for 2xx; throws HttpError otherwise (message redacted).
 */
export async function requestJson(
  url: string,
  init: { headers: Record<string, string>; body?: unknown },
  opts: { timeoutMs: number; retries: number; deps: ProviderDeps; queuedMs?: number },
): Promise<HttpResult> {
  const doFetch = opts.deps.fetch ?? fetch;
  const u = new URL(url);
  const target = `${u.origin}${u.pathname}`;
  const sleep = opts.deps.sleep ?? defaultSleep;
  const env = opts.deps.env ?? process.env;
  let lastError: HttpError | null = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    let res: Response | null = null;
    const startedMs = performance.now();
    const inFlight = (inFlightByOrigin.get(u.origin) ?? 0) + 1;
    inFlightByOrigin.set(u.origin, inFlight);
    const stat: CallStat = { target, startedMs, queuedMs: attempt === 0 ? (opts.queuedMs ?? 0) : 0, headersMs: null, totalMs: 0, status: null, inFlight, rateHeaders: {}, error: null };
    const finish = (error: string | null) => {
      stat.totalMs = performance.now() - startedMs;
      stat.error = error;
      inFlightByOrigin.set(u.origin, Math.max(0, (inFlightByOrigin.get(u.origin) ?? 1) - 1));
      if (callStats.length >= MAX_STATS) callStats.shift();
      callStats.push(stat);
    };
    try {
      res = await doFetch(url, {
        method: init.body === undefined ? "GET" : "POST",
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      stat.headersMs = performance.now() - startedMs;
      stat.status = res.status;
      res.headers.forEach((value, name) => {
        if (/^(retry-after|retry-after-ms|x-ratelimit-.*|ratelimit.*)$/i.test(name)) stat.rateHeaders[name] = value;
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (res.ok) {
        finish(null);
        return { status: res.status, json, attempts: attempt + 1 };
      }
      const detail = JSON.stringify(json?.error ?? json?.detail ?? json ?? "");
      lastError = new HttpError(redact(`http ${res.status} ${detail}`, env), res.status, json);
      finish(lastError.message);
      if (!RETRYABLE_STATUSES.has(res.status)) throw lastError;
    } catch (e) {
      if (e instanceof HttpError && (e.status === null || !RETRYABLE_STATUSES.has(e.status))) throw e;
      if (!(e instanceof HttpError)) {
        const name = (e as Error)?.name;
        const msg = name === "TimeoutError" || name === "AbortError" ? `timeout after ${opts.timeoutMs} ms` : String((e as Error)?.message ?? e);
        lastError = new HttpError(redact(`network error: ${msg}`, env), null);
        finish(lastError.message);
      }
    }
    if (attempt < opts.retries) await sleep(retryDelayMs(res, attempt));
  }
  throw lastError ?? new HttpError("request failed", null);
}

/** Retries allowed for a request: config retries in offline mode, none in live mode. */
export function retriesFor(p: ProviderConfig, mode: DecisionRequest["mode"]): number {
  return mode === "offline" ? p.retries : 0;
}

// ── concurrency limiters, one per (provider id) per process ──────────────────

const limiters = new Map<string, ReturnType<typeof pLimit>>();

/** The shared p-limit limiter for a provider id, sized from config concurrency. */
export function limiterFor(id: ProviderId, p: ProviderConfig): ReturnType<typeof pLimit> {
  const key = `${id}:${p.concurrency}`;
  let l = limiters.get(key);
  if (!l) {
    l = pLimit(p.concurrency);
    limiters.set(key, l);
  }
  return l;
}

// ── spend tracking (per process = per run) ───────────────────────────────────

const spent = new Map<ProviderId, number>();

/** Dollars spent so far in this process, per provider and in total. */
export function spendSoFar(): { byProvider: Record<string, number>; total: number } {
  const byProvider = Object.fromEntries(spent);
  return { byProvider, total: [...spent.values()].reduce((a, b) => a + b, 0) };
}

/** Add a real call's cost to the running spend. */
export function addSpend(id: ProviderId, usd: number): void {
  spent.set(id, (spent.get(id) ?? 0) + usd);
}

/** Reset the running spend (start of a run, and tests). */
export function resetSpend(): void {
  spent.clear();
}

/**
 * Null when a call may proceed; otherwise the reason it would exceed a spend cap.
 * `estimateUsd` is the expected cost of the call about to be made, so a run stops BEFORE a call
 * would take it over the cap rather than after.
 */
export function spendCapBlock(cfg: Config, id: ProviderId, estimateUsd = 0): string | null {
  const cap = cfg.spendCapsUsd.perProviderPerRun[id];
  const mine = spent.get(id) ?? 0;
  if (cap !== undefined && mine + estimateUsd > cap) return `spend cap for ${id}: $${mine.toFixed(4)} spent of $${cap}, the next call would exceed it`;
  const total = spendSoFar().total;
  if (total + estimateUsd > cfg.spendCapsUsd.totalPerRun) return `total spend cap: $${total.toFixed(4)} spent of $${cfg.spendCapsUsd.totalPerRun}, the next call would exceed it`;
  return null;
}

/** Rough cost of a call before it is made: about 3.5 characters per input token. */
export function estimateCostUsd(cfg: Config, id: ProviderId, model: string | null, inputChars: number, outputTokens: number): number {
  const prices = cfg.pricesPerMTokUsd;
  const price = (model !== null ? prices.byModel[model] : undefined) ?? prices.byId[id];
  if (!price || price.input === null || price.output === null) return 0;
  return ((inputChars / 3.5) * price.input + outputTokens * price.output) / 1_000_000;
}

/** Record one real call in the ledger (through deps.record when given) and add its spend. */
export function recordRealCall(cfg: Config, id: ProviderId, deps: ProviderDeps, input: Omit<UsageInput, "purpose"> & { purpose?: string }): void {
  addSpend(id, input.costUsd ?? 0);
  const entry = { ...input, purpose: input.purpose ?? deps.purpose ?? "decision", runId: deps.runId ?? null } as UsageInput;
  try {
    (deps.record ?? recordUsage)(cfg, entry);
  } catch (e) {
    // The ledger must never break a live match; report it once on stderr.
    console.error(`ledger write failed: ${redact(String(e))}`);
  }
}
