/**
 * drex_mock (owner: P2): returns answers shaped exactly like the real Drex adapter's, without
 * touching the network. Every response is tagged meta.isMock = true.
 *
 * The answers are pseudo-random but deterministic in (seed, question id, option label), so the
 * same request always gets the same response. They carry no strategic signal: anything measured
 * with this provider is plumbing, not a result.
 */
import type { Answer, DecisionProvider, DecisionRequest, DecisionResponse, Question } from "../contracts";
import { Rng, hashString } from "../util/rng";
import { localMeta } from "./shared";

export const DREX_MOCK_MODEL = "drex-mock";

function unit(seed: number, ...parts: string[]): number {
  return Rng.fromSeed(seed ^ hashString(parts.join("\u0000"))).next();
}

/** Softmax over pseudo-random scores, giving a peaked but full distribution like Drex returns. */
function distribution(seed: number, questionId: string, labels: readonly string[]): Record<string, number> {
  const weights = labels.map((label) => Math.exp(3 * unit(seed, questionId, label)));
  const total = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(labels.map((label, i) => [label, weights[i]! / total]));
}

function answer(seed: number, q: Question): Answer {
  switch (q.kind) {
    case "choice": {
      const probabilities = distribution(seed, q.id, (q.options ?? []).map((o) => o.label));
      const [chosen, confidence] = Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      return { chosen, probabilities, confidence };
    }
    case "noul": {
      const probability = unit(seed, q.id, "noul");
      return { probability, confidence: Math.max(probability, 1 - probability) };
    }
    case "score": {
      const levels = q.levels ?? [];
      const probabilities = distribution(seed, q.id, levels.map((_, i) => String(i)));
      const expectedScore = levels.reduce((sum, _, i) => sum + i * probabilities[String(i)]!, 0);
      return { expectedScore, probabilities, confidence: Math.max(...Object.values(probabilities)) };
    }
  }
}

export const drexMockProvider: DecisionProvider = {
  id: "drex_mock",
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const answers = Object.fromEntries(req.questions.map((q) => [q.id, answer(req.seed, q)]));
    return { answers, meta: localMeta("drex_mock", DREX_MOCK_MODEL, started, { isMock: true }) };
  },
};
