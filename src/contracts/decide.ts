/**
 * Decision contract: the provider-neutral request/response that every decision provider speaks
 * (owner of implementations: P2).
 *
 * The shape mirrors the Drex API (POST https://console.nace.ai/v1/systemone) so the Drex adapter
 * is a thin rename, while LLM adapters render the same questions into a prompt:
 *
 *   ours                      Drex wire format
 *   ------------------------  ------------------------------------------------------------
 *   stateText                 state
 *   questions[].id            key in the `questions` object
 *   kind "choice" + options   type "choice", criteria = { [label]: description }
 *   kind "noul"               type "noul" (a yes/no question; answer is P(yes))
 *   kind "score"  + levels    type "score", criteria = levels[] (index = score, lowest first)
 *   answers[id].chosen        answers[id].choice
 *   answers[id].probabilities answers[id].probabilities
 *   answers[id].probability   answers[id].noul
 *   answers[id].expectedScore sum(i * probabilities[i]) over answers[id].probabilities
 *   meta.inputTokens          usage.input_tokens (Drex bills input tokens only)
 *
 * Limits to respect (Drex docs): 1–512 questions per request, up to 255 options or levels each.
 */
import { z } from "zod";

/**
 * Every decision provider id. `drex_mock`, `scripted` and `random` never touch the network.
 *   drex      - System 1: Nace's closed-choice decision model
 *   deepinfra - System 2: a large LLM on DeepInfra (OpenAI-compatible chat completions); the
 *               "giant" Drex is compared against
 *   openai, gemini - optional secondary baselines, used only when their API key is set
 */
export const ProviderIdSchema = z.enum(["drex", "drex_mock", "deepinfra", "openai", "gemini", "scripted", "random"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const PROVIDER_IDS = ProviderIdSchema.options;

/**
 * Question kind.
 *   choice - pick exactly one of `options`
 *   noul   - yes/no question; the answer is a single probability of "yes"
 *   score  - rate on the ordered scale `levels` (lowest first)
 */
export const QuestionKindSchema = z.enum(["choice", "noul", "score"]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

/** One selectable option of a choice question. */
export const QuestionOptionSchema = z.object({
  /** Stable label the provider must return verbatim (an IntentOption.label for action questions). */
  label: z.string().min(1),
  /** One-sentence plain-English description shown to the model verbatim. */
  description: z.string(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/** One question about the state. */
export const QuestionSchema = z
  .object({
    /** Question id, unique within the request; keys the answer. */
    id: z.string().min(1),
    /** Question kind. */
    kind: QuestionKindSchema,
    /** What is being asked, in plain English. */
    instructions: z.string().min(1),
    /** The closed set of options. Required for kind "choice". */
    options: z.array(QuestionOptionSchema).min(1).max(255).optional(),
    /** Ordered scale labels, lowest first. Required for kind "score". */
    levels: z.array(z.string().min(1)).min(1).max(255).optional(),
  })
  .refine((q) => q.kind !== "choice" || q.options !== undefined, { message: "choice questions need options", path: ["options"] })
  .refine((q) => q.kind !== "score" || q.levels !== undefined, { message: "score questions need levels", path: ["levels"] });
export type Question = z.infer<typeof QuestionSchema>;

export const DecisionRequestSchema = z.object({
  /** The situation, rendered as text. Identical text goes to every provider being compared. */
  stateText: z.string(),
  /** One or more questions about the state; all are answered in one call. */
  questions: z.array(QuestionSchema).min(1).max(512),
  /** Seed for providers that are stochastic (random, mock, LLM sampling where supported). */
  seed: z.number().int(),
  /**
   * live    - a match is waiting: obey the provider timeout, fall back rather than stall
   * offline - benchmark run: retries and caching are allowed
   */
  mode: z.enum(["live", "offline"]),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** The answer to one question. Which fields are set depends on the question kind. */
export const AnswerSchema = z.object({
  /** choice: the label picked. Always one of the question's option labels. */
  chosen: z.string().optional(),
  /** choice: probability per option label; null when the provider cannot supply probabilities. */
  probabilities: z.record(z.string(), z.number()).nullable().optional(),
  /** noul: probability (0..1) that the answer is yes. */
  probability: z.number().min(0).max(1).optional(),
  /** score: expected level index (0 = lowest level). */
  expectedScore: z.number().optional(),
  /** Provider's confidence in this answer (0..1), when it reports one. */
  confidence: z.number().min(0).max(1).optional(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** Bookkeeping for one provider call. */
export const DecisionMetaSchema = z.object({
  /** Provider that produced the answers. */
  provider: ProviderIdSchema,
  /** Model id the provider reported (for example "drex-v2.0"); a fixed name for non-network providers. */
  model: z.string(),
  /** Wall-clock milliseconds from request sent to answers parsed, including retries. */
  latencyMs: z.number().nonnegative(),
  /** Input tokens billed; 0 for non-network providers. */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens billed; 0 for non-network providers. */
  outputTokens: z.number().int().nonnegative(),
  /** Cost of this call in US dollars, from config prices; 0 when prices are not filled in. */
  costUsd: z.number().nonnegative(),
  /** True when the provider failed and the answers came from the fallback policy instead. */
  fallbackUsed: z.boolean(),
  /** True when the answers came from the on-disk cache rather than a fresh call. */
  cached: z.boolean(),
  /** Error message when something went wrong (even if a fallback answered); otherwise null. */
  error: z.string().nullable(),
  /** True when the answers are synthetic (mock provider). Mock results must never be reported as real. */
  isMock: z.boolean(),
});
export type DecisionMeta = z.infer<typeof DecisionMetaSchema>;

export const DecisionResponseSchema = z.object({
  /** Answers keyed by question id; every question in the request has an entry. */
  answers: z.record(z.string(), AnswerSchema),
  /** Call bookkeeping. */
  meta: DecisionMetaSchema,
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** The interface every provider implements. */
export interface DecisionProvider {
  /** Which provider this is. */
  readonly id: ProviderId;
  /**
   * Answer every question in the request.
   * Must not throw for provider/network failures: return fallback answers with
   * meta.fallbackUsed = true and meta.error set, so a live match never stalls.
   */
  decide(req: DecisionRequest): Promise<DecisionResponse>;
}
