/**
 * RL from archived quirk states (notes/decisions.md, F4: "find, then RL refines").
 *
 * Interface only. Nothing here is implemented and no result in this repo comes from RL.
 * Intended design: start RL episodes from the archived start states of a quirk or chain (as in
 * Salimans & Chen 2018 and Go-Explore's robustification phase) and compare the cost to reach the
 * quirk's value against RL from the world's normal start, at equal budget in cost units.
 */
import type { CostParts, GoalSpec, QuirkNode } from "../contracts";

export interface RlBudget {
  /** Stop when the total cost in USD (see src/util/cost.ts) reaches this. */
  maxCostUsd: number;
}

export interface RlResult {
  /** Best value reached on the goal's first metric. */
  bestValue: number;
  /** Cost to first reach `targetValue`, or null if it was never reached. */
  costToTarget: CostParts | null;
  totalCost: CostParts;
}

/** TODO: implement for one world, then run the F4 comparison. */
export interface RlTrainer {
  trainFrom(starts: readonly QuirkNode[], goal: GoalSpec, targetValue: number, budget: RlBudget): Promise<RlResult>;
}
