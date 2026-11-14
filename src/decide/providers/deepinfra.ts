/**
 * deepinfra (System 2, owner: P2): a large LLM on DeepInfra, the "giant" Drex is compared to.
 * Also the template for the optional openai provider (same OpenAI-compatible chat API).
 *
 * Fairness: the prompt carries the IDENTICAL stateText, question instructions and option
 * labels + descriptions that Drex receives (see renderLlmPrompt), plus only the formatting
 * instructions an LLM needs to answer in JSON. No hints that Drex does not get.
 *
 * Model choice when cfg model is null: list modelsEndpoint once per process, try
 * modelPreference in order (largest first) among the listed ids, and on an access error move to
 * the next id. The exact id in use is logged on stderr once and returned by resolveModel(), so
 * run manifests can record it; meta.model is always the exact id that answered.
 *
 * Thinking: default "off" for deepinfra. Measured 2026-11-14 on a 68-option play call with
 * Qwen/Qwen3.5-397B-A17B: thinking off answered in about 1.1 s (12 output tokens, about $0.001);
 * the model's default (thinking on) took 71 s and 3,300 output tokens ($0.011) and picked the
 * same option, which also overran the 30 s config timeout. Use thinking "on" (spec suffix
 * "@think", e.g. "deepinfra@think") for an offline System 2 quality tier.
 *
 * temperature 0, response_format json_object, one parse-retry (the model is shown why its reply
 * was rejected), then fallback. Never throws. Every real HTTP call is recorded in the ledger;
 * cost is the response's usage.estimated_cost when present, else config prices.
 */
import { costFromConfig } from "../../ledger";
import type { Answer, Config, DecisionProvider, DecisionRequest, DecisionResponse, ProviderId, Question } from "../../contracts";
import { fallbackResponse } from "./shared";
import { HttpError, authHeaders, estimateCostUsd, limiterFor, recordRealCall, requestJson, retriesFor, spendCapBlock, type ProviderDeps } from "./http";

export interface ChatProviderOptions extends ProviderDeps {
  /** Exact model id to use (skips the model list and preference order). */
  model?: string;
  /** max_tokens for the completion (default 4096; reasoning models need room to think). */
  maxTokens?: number;
  /** Per-request timeout override, milliseconds (default: config timeoutMs). */
  timeoutMs?: number;
  /**
   * Reasoning ("thinking") mode for hybrid reasoning models:
   *   "default" - send nothing; the model thinks or not as its provider defaults
   *   "off"     - ask the model not to think (chat_template_kwargs.enable_thinking = false);
   *               the default for deepinfra
   *   "on"      - ask the model to think (chat_template_kwargs.enable_thinking = true)
   */
  thinking?: "default" | "off" | "on";
  /**
   * Answer a multi-question request with one chat call per question, run concurrently
   * (default true). Each call carries the identical stateText and that one question, so a
   * robot's private self-description in its question never reaches another robot's answer.
   */
  splitQuestions?: boolean;
}

/** A chat provider that can say exactly which model it is using. */
export interface ChatDecisionProvider extends DecisionProvider {
  /** Resolve (once) and return the exact model id that will answer, or null if none is usable. */
  resolveModel(): Promise<string | null>;
}

export const LLM_SYSTEM_PROMPT =
  "You make in-match strategy decisions for one robot in an FRC REBUILT 2026 match. Read the match state, answer every question, and reply with only a JSON object in the format the user gives. No other text.";

function questionBlock(q: Question): string {
  switch (q.kind) {
    case "choice":
      return [`Question "${q.id}" (choose exactly one option):`, q.instructions, "Options (label: description):", ...(q.options ?? []).map((o) => `- ${o.label}: ${o.description}`)].join("\n");
    case "noul":
      return [`Question "${q.id}" (yes or no):`, q.instructions].join("\n");
    case "score":
      return [`Question "${q.id}" (rate on this scale, lowest first):`, q.instructions, `Scale: ${(q.levels ?? []).join(" < ")}`].join("\n");
  }
}

function answerShape(q: Question): string {
  switch (q.kind) {
    case "choice":
      return `"${q.id}": {"choice": "<one option label, copied exactly>"}`;
    case "noul":
      return `"${q.id}": {"probability_yes": <number from 0 to 1>}`;
    case "score":
      return `"${q.id}": {"level": "<one scale level, copied exactly>"}`;
  }
}

/** The user message for a request: the same state, instructions and options Drex gets. */
export function renderLlmPrompt(req: DecisionRequest): string {
  return [
    "MATCH STATE",
    req.stateText,
    "",
    "QUESTIONS",
    req.questions.map(questionBlock).join("\n\n"),
    "",
    `Reply with one JSON object of exactly this form: {${req.questions.map(answerShape).join(", ")}}`,
  ].join("\n");
}

/** Pull the first JSON object out of a model reply (tolerates think tags and code fences). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Parse the model's JSON into answers; throws with a short reason when anything is invalid. */
export function parseLlmAnswers(req: DecisionRequest, text: string): Record<string, Answer> {
  let obj: any;
  try {
    obj = extractJson(text);
  } catch (e) {
    throw new Error(`reply is not valid JSON (${(e as Error).message})`);
  }
  const answers: Record<string, Answer> = {};
  for (const q of req.questions) {
    let a = obj?.[q.id];
    // A single-question reply may come back unwrapped.
    if (a === undefined && req.questions.length === 1) a = obj;
    if (a === undefined || a === null) throw new Error(`no answer for question "${q.id}"`);
    if (typeof a !== "object") a = q.kind === "choice" ? { choice: a } : q.kind === "noul" ? { probability_yes: a } : { level: a };
    if (q.kind === "choice") {
      const labels = (q.options ?? []).map((o) => o.label);
      const chosen = typeof a.choice === "string" ? a.choice.trim() : a.choice;
      if (typeof chosen !== "string" || !labels.includes(chosen)) throw new Error(`question "${q.id}": ${JSON.stringify(chosen)} is not one of the option labels`);
      answers[q.id] = { chosen, probabilities: null };
    } else if (q.kind === "noul") {
      const raw = a.probability_yes ?? a.probability ?? a.answer;
      const p = typeof raw === "boolean" ? (raw ? 1 : 0) : typeof raw === "string" && /^(yes|no)$/i.test(raw) ? (/^yes$/i.test(raw) ? 1 : 0) : Number(raw);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`question "${q.id}": probability_yes ${JSON.stringify(raw)} is not a number from 0 to 1`);
      answers[q.id] = { probability: p };
    } else {
      const levels = q.levels ?? [];
      const raw = a.level ?? a.score;
      const i = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < levels.length ? raw : levels.indexOf(String(raw).trim());
      if (i < 0) throw new Error(`question "${q.id}": ${JSON.stringify(raw)} is not one of the scale levels`);
      answers[q.id] = { expectedScore: i };
    }
  }
  return answers;
}

const isAccessError = (e: unknown) =>
  e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404 || (e.status === 400 && /model/i.test(e.message)));

/**
 * OpenAI-compatible chat provider. `id` is the provider id ("deepinfra" or "openai"); its config
 * entry supplies endpoint, auth, model or modelPreference, concurrency, timeout and retries.
 */
export function chatProvider(id: Extract<ProviderId, "deepinfra" | "openai">, cfg: Config, opts: ChatProviderOptions = {}): ChatDecisionProvider {
  const p = cfg.providers.byId[id];
  const env = opts.env ?? process.env;
  const limit = limiterFor(id, p);
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? p.timeoutMs;
  const thinking = opts.thinking ?? (id === "deepinfra" ? "off" : "default");
  const fixedModel = opts.model ?? (p.model && !p.model.startsWith("TODO_") ? p.model : null);

  let candidates: Promise<string[]> | null = null;
  let announced: string | null = null;
  const dropped = new Set<string>();

  function listCandidates(key: string): Promise<string[]> {
    if (fixedModel) return Promise.resolve([fixedModel]);
    candidates ??= (async () => {
      const pref = p.modelPreference ?? [];
      if (!p.modelsEndpoint) return pref;
      try {
        const { json } = await requestJson(p.modelsEndpoint, { headers: authHeaders(p, key) }, { timeoutMs: Math.max(p.timeoutMs, 10_000), retries: 1, deps: opts });
        const listed = new Set<string>((json?.data ?? []).map((m: { id: string }) => m.id));
        const available = pref.filter((m) => listed.has(m));
        return available.length > 0 ? available : pref;
      } catch {
        return pref; // listing failed: try the preference list blind
      }
    })();
    return candidates;
  }

  async function currentModel(key: string): Promise<string | null> {
    const model = (await listCandidates(key)).find((m) => !dropped.has(m)) ?? null;
    if (model && model !== announced) {
      announced = model;
      console.error(`${id}: using model ${model}`);
    }
    return model;
  }

  async function call(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const label = fixedModel ?? announced ?? "unresolved";
    const key = env[p.apiKeyEnv ?? ""];
    if (!p.endpoint || !key) return fallbackResponse(req, id, label, started, `${p.apiKeyEnv ?? `${id} api key`} is not set`);
    // Estimate: prompt = state text + instructions + options + ~600 chars of framing; output = a
    // few tokens, or the full max_tokens budget when thinking.
    const promptChars = req.stateText.length + req.questions.reduce((s, q) => s + q.instructions.length + (q.options ?? []).reduce((t, o) => t + o.label.length + o.description.length + 4, 0), 0) + 600;
    const blocked = spendCapBlock(cfg, id, estimateCostUsd(cfg, id, fixedModel ?? announced, promptChars, thinking === "on" ? maxTokens : 50));
    if (blocked) return fallbackResponse(req, id, label, started, blocked);

    const messages: { role: string; content: string }[] = [
      { role: "system", content: LLM_SYSTEM_PROMPT },
      { role: "user", content: renderLlmPrompt(req) },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let model: string | null = null;
    let parseAttempts = 0;
    let lastError = "";

    while (true) {
      model = await currentModel(key);
      if (!model) return withUsage(fallbackResponse(req, id, label, started, `${id}: no usable model (${lastError || "none of modelPreference is available"})`));
      const body: Record<string, unknown> = { model, messages, temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" } };
      body.seed = req.seed;
      if (thinking !== "default") body.chat_template_kwargs = { enable_thinking: thinking === "on" };
      const callStarted = performance.now();
      let json: any;
      try {
        ({ json } = await requestJson(p.endpoint, { headers: authHeaders(p, key), body }, { timeoutMs, retries: retriesFor(p, req.mode), deps: opts }));
      } catch (e) {
        lastError = `${model}: ${(e as Error).message}`;
        // The request was sent, so it may have been billed: record it (tokens unknown = 0).
        recordRealCall(cfg, id, opts, { tool: id, model, latencyMs: performance.now() - callStarted, costUsd: 0, purpose: `${opts.purpose ?? "decision"}_failed` });
        if (!fixedModel && isAccessError(e)) {
          dropped.add(model);
          continue;
        }
        return withUsage(fallbackResponse(req, id, model, started, `${id} ${lastError}`));
      }
      const u = json?.usage ?? {};
      const inT = Math.max(0, Math.round(Number(u.prompt_tokens) || 0));
      const outT = Math.max(0, Math.round(Number(u.completion_tokens) || 0));
      const reported = Number(u.estimated_cost);
      const cost = Number.isFinite(reported) && reported >= 0 ? reported : (costFromConfig(cfg, id, model, inT, outT) ?? 0);
      inputTokens += inT;
      outputTokens += outT;
      costUsd += cost;
      recordRealCall(cfg, id, opts, { tool: id, model, inputTokens: inT, outputTokens: outT, latencyMs: performance.now() - callStarted, costUsd: cost });

      const choice = json?.choices?.[0];
      const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
      try {
        const answers = parseLlmAnswers(req, text);
        return {
          answers,
          meta: { provider: id, model, latencyMs: performance.now() - started, inputTokens, outputTokens, costUsd, fallbackUsed: false, cached: false, error: null, isMock: false },
        };
      } catch (e) {
        lastError = `${(e as Error).message}${choice?.finish_reason === "length" ? " (reply cut off at max_tokens)" : ""}`;
        parseAttempts += 1;
        if (parseAttempts > 1) return withUsage(fallbackResponse(req, id, model, started, `${id} ${model}: unusable reply after a parse-retry: ${lastError}`));
        messages.push({ role: "assistant", content: text.slice(0, 2000) });
        messages.push({ role: "user", content: `Your reply was rejected: ${lastError}. Reply again with only the JSON object in the required form, using labels copied exactly.` });
      }
    }

    function withUsage(res: DecisionResponse): DecisionResponse {
      res.meta.inputTokens = inputTokens;
      res.meta.outputTokens = outputTokens;
      res.meta.costUsd = costUsd;
      return res;
    }
  }

  async function decideSplit(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const parts = await Promise.all(req.questions.map((q) => limit(() => call({ ...req, questions: [q] }))));
    const metas = parts.map((r) => r.meta);
    const errors = metas.map((m) => m.error).filter((e): e is string => e !== null);
    return {
      answers: Object.assign({}, ...parts.map((r) => r.answers)),
      meta: {
        provider: id,
        model: [...new Set(metas.map((m) => m.model))].join(","),
        latencyMs: performance.now() - started,
        inputTokens: metas.reduce((s, m) => s + m.inputTokens, 0),
        outputTokens: metas.reduce((s, m) => s + m.outputTokens, 0),
        costUsd: metas.reduce((s, m) => s + m.costUsd, 0),
        fallbackUsed: metas.some((m) => m.fallbackUsed),
        cached: metas.every((m) => m.cached),
        error: errors.length > 0 ? errors.join(" | ") : null,
        isMock: false,
      },
    };
  }

  const split = opts.splitQuestions ?? true;
  return {
    id,
    decide: (req) => (split && req.questions.length > 1 ? decideSplit(req) : limit(() => call(req))),
    async resolveModel() {
      const key = env[p.apiKeyEnv ?? ""];
      if (!key) return fixedModel;
      return currentModel(key);
    },
  };
}

/** The deepinfra provider (System 2). */
export function deepinfraProvider(cfg: Config, opts: ChatProviderOptions = {}): ChatDecisionProvider {
  return chatProvider("deepinfra", cfg, opts);
}
