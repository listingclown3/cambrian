/**
 * Plain-words goal -> measurable metrics, with a human approval gate (notes/decisions.md).
 *
 * The user states a goal ("max points", "don't get defended"); a translator turns it into metric
 * specs; the user approves them; only then may search start. `requireApproved` is the gate every
 * search entry point calls first.
 */
import { GoalSpecSchema, type GoalMetric, type GoalSpec } from "../contracts";

export class GoalNotApprovedError extends Error {
  constructor(goal: GoalSpec) {
    super(`goal "${goal.text}" has not been approved; review its ${goal.metrics.length} metric(s) and approve before searching`);
    this.name = "GoalNotApprovedError";
  }
}

/** A new, unapproved goal. */
export function draftGoal(text: string, world: string, metrics: GoalMetric[]): GoalSpec {
  return GoalSpecSchema.parse({ text, world, metrics, approved: false, approvedBy: null, approvedTs: null });
}

/** Approve a goal as reviewed by `by`. Changing metrics afterwards means drafting a new goal. */
export function approveGoal(goal: GoalSpec, by: string, now: Date = new Date()): GoalSpec {
  if (!by.trim()) throw new Error("approval needs a reviewer name");
  return GoalSpecSchema.parse({ ...goal, approved: true, approvedBy: by, approvedTs: now.toISOString() });
}

/** Throws unless the goal is approved and well-formed. Call before any search starts. */
export function requireApproved(goal: GoalSpec): asserts goal is GoalSpec & { approved: true } {
  const g = GoalSpecSchema.parse(goal);
  if (!g.approved || !g.approvedBy || !g.approvedTs) throw new GoalNotApprovedError(g);
}

/**
 * Turns plain words into metric specs for a world. The intended implementation is the world
 * builder model (the most capable model available), prompted with the world's metric list.
 * TODO: implement; until then metrics are written by hand with `draftGoal`.
 */
export interface GoalTranslator {
  translate(text: string, world: { id: string; metrics: readonly GoalMetric[] }): Promise<GoalMetric[]>;
}
