/**
 * Helpers shared by all providers (owner: P2).
 */
import type { Answer, DecisionMeta, DecisionRequest, DecisionResponse, ProviderId, Question } from "../../contracts";

/** Meta for a call that never touched the network. */
export function localMeta(provider: ProviderId, model: string, startedMs: number, overrides: Partial<DecisionMeta> = {}): DecisionMeta {
  return {
    provider,
    model,
    latencyMs: performance.now() - startedMs,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    fallbackUsed: false,
    cached: false,
    error: null,
    isMock: false,
    ...overrides,
  };
}

/**
 * The safe default answer to one question: first option, probability 0.5, lowest level.
 * Used by the scripted provider and as the fallback when a real provider fails.
 */
export function defaultAnswer(question: Question): Answer {
  switch (question.kind) {
    case "choice":
      return { chosen: question.options?.[0]?.label, probabilities: null };
    case "noul":
      return { probability: 0.5 };
    case "score":
      return { expectedScore: 0 };
  }
}

/** Fallback response for a failed provider call: default answers, fallbackUsed = true, error set. */
export function fallbackResponse(req: DecisionRequest, provider: ProviderId, model: string, startedMs: number, error: string): DecisionResponse {
  return {
    answers: Object.fromEntries(req.questions.map((q) => [q.id, defaultAnswer(q)])),
    meta: localMeta(provider, model, startedMs, { fallbackUsed: true, error }),
  };
}
