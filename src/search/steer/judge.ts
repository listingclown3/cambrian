/**
 * judgeIncidents (owner: P2): ask a provider whether incidents broke rules, as a batch of yes/no
 * (noul) questions about one shared description of the match moment. One Drex call answers up
 * to 512 (incident, rule) pairs; larger batches are split into several calls.
 *
 * The provider sees only the text given here; callers build it from public information
 * (ObservationView-level facts and the rule text with its manual citation).
 */
import type { DecisionMeta, DecisionProvider, DecisionRequest } from "../../contracts";

export interface Incident {
  /** Stable id (letters, digits, _ or -). */
  id: string;
  /** What happened, in plain English (who, where, how long). */
  description: string;
}

export interface RuleToJudge {
  /** Stable id, e.g. the manual rule number "G418". */
  id: string;
  /** The rule text a referee applies. */
  text: string;
}

export interface Judgment {
  incidentId: string;
  ruleId: string;
  /** Probability (0..1) that the incident violated the rule. */
  pViolation: number;
  /** True when this judgment is a fallback (provider failed), not a real answer. */
  fallbackUsed: boolean;
}

export interface JudgeResult {
  judgments: Judgment[];
  metas: DecisionMeta[];
}

const MAX_QUESTIONS = 512;
export const judgeQuestionId = (incidentId: string, ruleId: string) => `violates__${incidentId}__${ruleId}`;

/** The requests that judge every (incident, rule) pair, split at the 512-question limit. */
export function buildJudgeRequests(context: string, incidents: readonly Incident[], rules: readonly RuleToJudge[], seed: number, mode: DecisionRequest["mode"]): DecisionRequest[] {
  const stateText = [context, "", "Incidents:", ...incidents.map((i) => `- ${i.id}: ${i.description}`), "", "Rules:", ...rules.map((r) => `- ${r.id}: ${r.text}`)].join("\n");
  const questions = incidents.flatMap((i) =>
    rules.map((r) => ({ id: judgeQuestionId(i.id, r.id), kind: "noul" as const, instructions: `Did incident ${i.id} violate rule ${r.id}? Answer yes only if the incident as described breaks the rule as written.` })),
  );
  const out: DecisionRequest[] = [];
  for (let k = 0; k < questions.length; k += MAX_QUESTIONS) out.push({ stateText, questions: questions.slice(k, k + MAX_QUESTIONS), seed: seed + out.length, mode });
  return out;
}

/** Judge every (incident, rule) pair. Never throws; failed pairs are flagged fallbackUsed. */
export async function judgeIncidents(
  provider: DecisionProvider,
  context: string,
  incidents: readonly Incident[],
  rules: readonly RuleToJudge[],
  opts: { seed?: number; mode?: DecisionRequest["mode"] } = {},
): Promise<JudgeResult> {
  if (incidents.length === 0 || rules.length === 0) return { judgments: [], metas: [] };
  const requests = buildJudgeRequests(context, incidents, rules, opts.seed ?? 0, opts.mode ?? "offline");
  const responses = await Promise.all(requests.map((r) => provider.decide(r)));
  const judgments: Judgment[] = [];
  for (const i of incidents) {
    for (const r of rules) {
      const qid = judgeQuestionId(i.id, r.id);
      const res = responses.find((x, k) => requests[k]!.questions.some((q) => q.id === qid))!;
      judgments.push({ incidentId: i.id, ruleId: r.id, pViolation: res.answers[qid]?.probability ?? 0.5, fallbackUsed: res.meta.fallbackUsed });
    }
  }
  return { judgments, metas: responses.map((r) => r.meta) };
}
