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
import { authHeaders, limiterFor, recordRealCall, requestJson, retriesFor, spendCapBlock, type ProviderDeps } from "./http";

export interface DrexOptions extends ProviderDeps {
  /** Drex model id to request (default: cfg.providers.byId.drex.model). */
  model?: string;
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

export function drexProvider(cfg: Config, opts: DrexOptions = {}): DecisionProvider & { readonly model: string } {
  const p = cfg.providers.byId.drex;
  const model = opts.model ?? p.model ?? "drex-v2.0";
  const env = opts.env ?? process.env;
  const limit = limiterFor("drex", p);

  async function call(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const key = env[p.apiKeyEnv ?? ""];
    if (!p.endpoint || !key) return fallbackResponse(req, "drex", model, started, `${p.apiKeyEnv ?? "drex api key"} is not set`);
    const blocked = spendCapBlock(cfg, "drex");
    if (blocked) return fallbackResponse(req, "drex", model, started, blocked);

    let json: any;
    try {
      ({ json } = await requestJson(p.endpoint, { headers: authHeaders(p, key), body: drexBody(model, req) }, { timeoutMs: p.timeoutMs, retries: retriesFor(p, req.mode), deps: opts }));
    } catch (e) {
      // The request was sent, so it may have been billed: record it (tokens unknown = 0).
      recordRealCall(cfg, "drex", opts, { tool: "drex", model, latencyMs: performance.now() - started, costUsd: 0, counts: { questions: req.questions.length }, purpose: `${opts.purpose ?? "decision"}_failed` });
      return fallbackResponse(req, "drex", model, started, `drex ${model}: ${(e as Error).message}`);
    }
    const latencyMs = performance.now() - started;
    const served = typeof json?.model === "string" ? json.model : model;
    const inputTokens = Math.max(0, Math.round(num(json?.usage?.input_tokens) ?? 0));
    const outputTokens = Math.max(0, Math.round(num(json?.usage?.output_tokens) ?? 0));
    const costUsd = costFromConfig(cfg, "drex", served, inputTokens, outputTokens) ?? 0;
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
    /** The model id requested (the served id, e.g. drex-max-v1.1 for drex-latest, is in meta.model). */
    model,
    // Latency is measured inside call(), i.e. from when the request is actually sent, not from
    // when it entered the concurrency queue.
    decide: (req) => limit(() => call(req)),
  };
}
