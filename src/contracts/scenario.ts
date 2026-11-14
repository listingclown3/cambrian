/**
 * Scenario contract: frozen decision points mined from matches, grouped into families, with an
 * answer key computed by rollouts (owner of producers: P3).
 */
import { z } from "zod";
import { RobotIdSchema } from "./common";
import { IntentOptionSchema } from "./actions";
import { SnapshotSchema } from "./state";

/** A family = one base scenario plus variants that each flip one thing about the context. */
export const ScenarioFamilySchema = z.object({
  /** Family id. */
  id: z.string().min(1),
  /**
   * The kind of sticky situation the family tests (for example "hub_about_to_deactivate",
   * "pinned_with_fuel", "endgame_climb_or_score"). Free text; families.ts owns the vocabulary.
   */
  stickyType: z.string().min(1),
  /** Plain-English description of the situation. */
  description: z.string(),
  /** Id of the unmodified scenario the variants were derived from. */
  baseScenarioId: z.string().min(1),
});
export type ScenarioFamily = z.infer<typeof ScenarioFamilySchema>;

/** Rollout statistics for one option. */
export const AnswerKeyValueSchema = z.object({
  /** Mean of (pointsFor - pointsAgainst) across rollouts that started with this option. */
  mean: z.number(),
  /** Half-width of the 95% confidence interval of the mean. */
  ci95: z.number().nonnegative(),
  /** Number of rollouts. */
  n: z.number().int().positive(),
});
export type AnswerKeyValue = z.infer<typeof AnswerKeyValueSchema>;

/** The answer key for one scenario. */
export const AnswerKeySchema = z.object({
  /** Statistics per option label. Every option of the scenario has an entry. */
  values: z.record(z.string(), AnswerKeyValueSchema),
  /** Label with the highest mean. */
  best: z.string(),
  /**
   * True when the best option is not clearly separated from the runner-up (confidence intervals
   * overlap). Ambiguous scenarios are excluded from top-1 accuracy but still count for regret.
   */
  ambiguous: z.boolean(),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

export const ScenarioSchema = z.object({
  /** Scenario id. */
  id: z.string().min(1),
  /** Family this scenario belongs to. */
  familyId: z.string().min(1),
  /** What was changed relative to the family's base scenario, in plain words ("" for the base). */
  flip: z.string(),
  /** The frozen match state. */
  snapshot: SnapshotSchema,
  /** Robot the decision is for. */
  focusRobotId: RobotIdSchema,
  /** The masked options for the focus robot in this snapshot. */
  options: z.array(IntentOptionSchema).min(2),
  /** Answer key, present once answerkey has been run. */
  answerKey: AnswerKeySchema.optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
