/**
 * Rollout batch task (owner: P1). Runs in a tinypool worker (see rolloutPool.ts), and can also be
 * called directly on the main thread; the results are identical either way, because a rollout is
 * a pure function of (snapshot, overrides, horizon, seed, policies).
 *
 * Policies cross the thread boundary by id (SCRIPTED_POLICIES), since functions cannot be posted.
 */
import type { Intent, RobotId, RolloutOptions, RolloutPolicies, ScriptedPolicy, Snapshot } from "../contracts";
import { engine } from "../engine";
import { SCRIPTED_POLICIES } from "./policies";

/** Scripted policy ids for a rollout: a default plus optional per-robot overrides. */
export interface RolloutPolicyIds {
  /** Policy id for every robot not listed in byRobot. */
  default: string;
  /** Per-robot policy ids. */
  byRobot?: Record<RobotId, string>;
}

/** One batch: the same start and overrides, one rollout per seed. */
export interface RolloutBatchTask {
  /** Where every rollout starts. */
  snapshot: Snapshot;
  /** Intents forced on some robots until they complete. */
  overrides: Record<RobotId, Intent>;
  /** Rollout horizon, seconds. */
  horizonS: number;
  /** One rollout per seed, results in the same order. */
  seeds: number[];
  /** Scripted policies by id. */
  policies: RolloutPolicyIds;
  /** Perspective etc., as for Engine.rollout. */
  options?: RolloutOptions;
  /** Return each rollout's final snapshot too (costly to post between threads; off by default). */
  keepFinalSnapshot?: boolean;
}

/** One rollout's outcome (RolloutResult with the final snapshot optional). */
export interface RolloutSummary {
  /** The seed this rollout used. */
  seed: number;
  /** Points the perspective alliance gained. */
  pointsFor: number;
  /** Points the other alliance gained. */
  pointsAgainst: number;
  /** Fouls committed by the perspective alliance. */
  foulsFor: number;
  /** Fouls committed by the other alliance. */
  foulsAgainst: number;
  /** Final snapshot, only when keepFinalSnapshot was set. */
  finalSnapshot?: Snapshot;
}

function policyById(id: string): ScriptedPolicy {
  const policy = SCRIPTED_POLICIES[id];
  if (!policy) throw new Error(`unknown scripted policy "${id}"; known: ${Object.keys(SCRIPTED_POLICIES).join(", ")}`);
  return policy;
}

/** Resolve policy ids to policies. */
export function resolvePolicies(ids: RolloutPolicyIds): RolloutPolicies {
  const byRobot = ids.byRobot ? Object.fromEntries(Object.entries(ids.byRobot).map(([robot, id]) => [robot, policyById(id)])) : undefined;
  return byRobot ? { default: policyById(ids.default), byRobot } : { default: policyById(ids.default) };
}

/** Run one batch of rollouts on this thread. */
export function runRolloutBatch(task: RolloutBatchTask): RolloutSummary[] {
  const policies = resolvePolicies(task.policies);
  return task.seeds.map((seed) => {
    const r = engine.rollout(task.snapshot, task.overrides, task.horizonS, seed, policies, task.options);
    const out: RolloutSummary = { seed, pointsFor: r.pointsFor, pointsAgainst: r.pointsAgainst, foulsFor: r.foulsFor, foulsAgainst: r.foulsAgainst };
    if (task.keepFinalSnapshot) out.finalSnapshot = r.finalSnapshot;
    return out;
  });
}

export default runRolloutBatch;
