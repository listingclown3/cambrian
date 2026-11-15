/**
 * Shapes for guided quirk discovery: worlds, goals, rules modes, the quirk archive and cost.
 * See notes/decisions.md for the definitions these encode.
 */
import { z } from "zod";

/** Tier 1 "game": the sim is the game, quirks are real by definition. Tier 2 "reality": the sim models something real, quirks must transfer. */
export const WorldTierSchema = z.enum(["game", "reality"]);
export type WorldTier = z.infer<typeof WorldTierSchema>;

/** off: only physics counts. flag: label rule breaks and keep them. enforce: discard rule breaks. */
export const RulesModeSchema = z.enum(["off", "flag", "enforce"]);
export type RulesMode = z.infer<typeof RulesModeSchema>;

/** Legality as judged from the rules (LEGAL / RISKY / ILLEGAL), or UNJUDGED when no judge ran. */
export const LegalitySchema = z.enum(["LEGAL", "RISKY", "ILLEGAL", "UNJUDGED"]);
export type Legality = z.infer<typeof LegalitySchema>;

/** A flat world-state value; worlds expose their state to the archive as a record of these. */
export const StateValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type StateValue = z.infer<typeof StateValueSchema>;
export const StateRecordSchema = z.record(z.string(), StateValueSchema);
export type StateRecord = z.infer<typeof StateRecordSchema>;

/** One start condition: `state[key] op value`. A missing key never satisfies a condition. */
export const ConditionSchema = z.strictObject({
  key: z.string().min(1),
  op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in"]),
  value: z.union([StateValueSchema, z.array(z.union([z.number(), z.string()]))]),
});
export type Condition = z.infer<typeof ConditionSchema>;

/** play: how to act in the world. design: what to build (a mechanism, an archetype). */
export const QuirkLevelSchema = z.enum(["play", "design"]);
export type QuirkLevel = z.infer<typeof QuirkLevelSchema>;

/** One archived quirk. */
export const QuirkNodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  level: QuirkLevelSchema,
  /** World id the quirk was found in. */
  world: z.string(),
  /** Where it came from: "lab", "rule_scan", "explore", "borrowed:<domain>", ... */
  source: z.string(),
  /** Conditions that must hold for the quirk to start. Empty = unknown or "anywhere": such a node only starts chains. */
  start: z.array(ConditionSchema),
  /** State the quirk leaves the world in (only the keys it determines). */
  end: StateRecordSchema,
  /** Measured effect on the goal metric. null value = not measured yet. */
  effect: z.strictObject({ value: z.number().nullable(), ci95: z.number().nullable(), n: z.number().int().nonnegative(), unit: z.string() }),
  /** What the prior predicted the effect would be, before measuring; null = no prediction recorded. */
  predicted: z.number().nullable(),
  legality: LegalitySchema,
  /** Rules checked, with the judged probability of a violation. */
  rules: z.array(z.strictObject({ id: z.string(), page: z.number().int().nullable(), pViolation: z.number().min(0).max(1).nullable() })),
  /** Independent re-runs and how many reproduced the effect. */
  reproducibility: z.strictObject({ runs: z.number().int().nonnegative(), reproduced: z.number().int().nonnegative() }),
  /** Search value: starts at 0 and rises through credit-back when the quirk appears in winning chains. */
  value: z.number(),
  notes: z.string(),
});
export type QuirkNode = z.infer<typeof QuirkNodeSchema>;

/** from -> to: the end state of `from` satisfies the start conditions of `to` (or a person linked them by hand). */
export const QuirkEdgeSchema = z.strictObject({ from: z.string(), to: z.string(), how: z.enum(["conditions", "manual"]) });
export type QuirkEdge = z.infer<typeof QuirkEdgeSchema>;

export const ArchiveFileSchema = z.strictObject({
  version: z.literal(1),
  world: z.string(),
  createdTs: z.string(),
  nodes: z.array(QuirkNodeSchema),
  edges: z.array(QuirkEdgeSchema),
});
export type ArchiveFile = z.infer<typeof ArchiveFileSchema>;

/** One measurable goal metric. */
export const GoalMetricSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string(),
  direction: z.enum(["max", "min"]),
  unit: z.string(),
});
export type GoalMetric = z.infer<typeof GoalMetricSchema>;

/** A plain-words goal and the metrics it was turned into. Search may start only once `approved` is true. */
export const GoalSpecSchema = z.strictObject({
  text: z.string().min(1),
  world: z.string(),
  metrics: z.array(GoalMetricSchema).min(1),
  approved: z.boolean(),
  approvedBy: z.string().nullable(),
  approvedTs: z.string().nullable(),
});
export type GoalSpec = z.infer<typeof GoalSpecSchema>;

/** Raw resource use behind one cost figure (see notes/decisions.md, "Cost unit"). */
export const CostPartsSchema = z.strictObject({
  modelApiUsd: z.number().nonnegative(),
  simCpuHours: z.number().nonnegative(),
  gpuHours: z.number().nonnegative(),
  simSteps: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export type CostParts = z.infer<typeof CostPartsSchema>;
