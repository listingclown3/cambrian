/**
 * Execution layer entry point (owner: P1): scripted policies, decision triggers, match runner.
 */
export { DEFAULT_POLICY_ID, SCRIPTED_POLICIES, archetypePolicy, basicCyclePolicy, holdPolicy } from "./policies";
export { bestCandidate, planManeuver, scoreCandidates, type CandidateScore, type MicroRolloutSettings } from "./maneuver";
export { RolloutPool, runRolloutBatch, type RolloutBatchTask, type RolloutSummary } from "./rolloutPool";
export { GLOBAL_TRIGGER_KINDS, ROBOT_TRIGGER_KINDS, isTriggerFor, robotsNeedingDecision } from "./triggers";
export { MatchRunner, type MatchRunnerOptions, type RunnerDecision, type RunnerTick } from "./matchRunner";
export { demoRobots } from "./demoMatch";
