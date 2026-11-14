/**
 * Non-network baseline providers (owner: P2): random and scripted.
 */
import type { Answer, DecisionProvider, DecisionRequest, DecisionResponse, Question } from "../../contracts";
import { Rng, hashString } from "../../util/rng";
import { defaultAnswer, localMeta } from "./shared";

function randomAnswer(rng: Rng, q: Question): Answer {
  switch (q.kind) {
    case "choice": {
      const labels = (q.options ?? []).map((o) => o.label);
      const p = 1 / labels.length;
      return { chosen: rng.pick(labels), probabilities: Object.fromEntries(labels.map((l) => [l, p])) };
    }
    case "noul":
      return { probability: 0.5 };
    case "score":
      return { expectedScore: ((q.levels?.length ?? 1) - 1) / 2 };
  }
}

/** Uniform random choice, seeded by the request. The floor every model must beat. */
export const randomProvider: DecisionProvider = {
  id: "random",
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const answers = Object.fromEntries(req.questions.map((q) => [q.id, randomAnswer(Rng.fromSeed(req.seed ^ hashString(q.id)), q)]));
    return { answers, meta: localMeta("random", "uniform", started) };
  },
};

/**
 * STUB: always picks the first option. The real scripted baseline is a ScriptedPolicy applied to
 * the ObservationView (see src/exec/policies.ts); P2/P3 decide how benchmarks call it, because a
 * DecisionRequest carries only text.
 */
export const scriptedProvider: DecisionProvider = {
  id: "scripted",
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const started = performance.now();
    const answers = Object.fromEntries(req.questions.map((q) => [q.id, defaultAnswer(q)]));
    return { answers, meta: localMeta("scripted", "first_option_stub", started) };
  },
};
