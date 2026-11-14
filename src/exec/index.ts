/**
 * Execution layer entry point (owner: P1): scripted policies, decision triggers, match runner.
 */
export { SCRIPTED_POLICIES, basicCyclePolicy, holdPolicy } from "./policies";
export { GLOBAL_TRIGGER_KINDS, ROBOT_TRIGGER_KINDS, isTriggerFor, robotsNeedingDecision } from "./triggers";
export { MatchRunner, type RunnerDecision, type RunnerTick } from "./matchRunner";
export { demoRobots } from "./demoMatch";
