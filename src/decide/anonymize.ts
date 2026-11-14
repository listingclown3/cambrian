/**
 * Anonymized-labels ablation (owner: P2): replace every choice option's label with a neutral id
 * (opt_01, opt_02, ...) while keeping its description verbatim, ask the provider, and map the
 * answer back. If a provider does about as well anonymized, it is reading the descriptions, not
 * pattern-matching on label names like "shoot_now".
 *
 * Applied identically to every provider in a comparison. Options are renumbered per question in
 * their original order, so the ablation changes nothing but the label strings.
 */
import type { Answer, DecisionProvider, DecisionRequest, DecisionResponse } from "../contracts";

/** Per question: neutral id -> original label. */
export type LabelMap = Record<string, Record<string, string>>;

export const neutralLabel = (i: number, n: number) => `opt_${String(i + 1).padStart(Math.max(2, String(n).length), "0")}`;

/** The request with neutral labels, plus the map back to the original labels. */
export function anonymizeRequest(req: DecisionRequest): { request: DecisionRequest; map: LabelMap } {
  const map: LabelMap = {};
  const questions = req.questions.map((q) => {
    if (q.kind !== "choice" || !q.options) return q;
    const back: Record<string, string> = {};
    const options = q.options.map((o, i) => {
      const id = neutralLabel(i, q.options!.length);
      back[id] = o.label;
      return { label: id, description: o.description };
    });
    map[q.id] = back;
    return { ...q, options };
  });
  return { request: { ...req, questions }, map };
}

/** Map a response to an anonymized request back to the original labels. */
export function deanonymizeResponse(res: DecisionResponse, map: LabelMap): DecisionResponse {
  const answers: Record<string, Answer> = {};
  for (const [qid, a] of Object.entries(res.answers)) {
    const back = map[qid];
    if (!back) {
      answers[qid] = a;
      continue;
    }
    answers[qid] = {
      ...a,
      ...(a.chosen !== undefined ? { chosen: back[a.chosen] ?? a.chosen } : {}),
      ...(a.probabilities ? { probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([l, p]) => [back[l] ?? l, p])) } : {}),
    };
  }
  return { answers, meta: res.meta };
}

/** Wrap a provider so every request it sees has neutral labels; answers come back in original labels. */
export function anonymizedProvider(inner: DecisionProvider): DecisionProvider {
  return {
    id: inner.id,
    async decide(req) {
      const { request, map } = anonymizeRequest(req);
      return deanonymizeResponse(await inner.decide(request), map);
    },
  };
}
