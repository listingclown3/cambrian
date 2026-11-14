/**
 * Decision layer entry point (owner: P2): providers, registry, request building.
 */
export { IMPLEMENTED_PROVIDERS, NETWORK_PROVIDERS, getProvider, getProviderBySpec, parseProviderSpec, providerLabel, providerModel, providerReasoning, warmupProvider, type ProviderOptions } from "./registry";
export {
  ACTION_QUESTION_ID,
  actionQuestionId,
  buildActionRequest,
  buildBatchActionRequest,
  buildCaptainRequest,
  captainQuestionId,
  captainRoleOptions,
  chosenIntent,
  chosenOption,
  describeRole,
  roleLabel,
} from "./ask";
export { renderSelfText, renderSharedStateText, renderStateText } from "./stateText";
export { AgentController, decisionRunEvents, type AllianceAgent, type AllianceTotals, type FairnessParams, type RobotBehaviour, type ControllerDecision, type ControllerOptions, type ControllerSummary, type RobotChoice, type TimingMode } from "./controller";
export { drexMockProvider, DREX_MOCK_MODEL } from "./providers/drexMock";
export { randomProvider, scriptedProvider } from "./providers/baselines";
export { defaultAnswer, fallbackResponse, localMeta } from "./providers/shared";
export { drexProvider, drexBody, parseDrexAnswer, type DrexOptions } from "./providers/drex";
export { chatProvider, deepinfraProvider, renderLlmPrompt, parseLlmAnswers, LLM_SYSTEM_PROMPT, type ChatDecisionProvider, type ChatProviderOptions } from "./providers/deepinfra";
export { redact, resetSpend, spendSoFar, spendCapBlock, type ProviderDeps } from "./providers/http";
export { cachedProvider, cacheKey, type CachedProvider, type CacheOptions } from "./cache";
export { anonymizedProvider, anonymizeRequest, deanonymizeResponse, neutralLabel, type LabelMap } from "./anonymize";
export { buildJudgeRequests, judgeIncidents, judgeQuestionId, type Incident, type Judgment, type JudgeResult, type RuleToJudge } from "./judge";
export { MatchRecorder } from "./recorder";
export { CLIMB_WINDOW_EXTRA_S, PROMPT_VERSION, accuracyAt, curateOptions, describeWithFacts, liveOptions, type OptionRules } from "./options";
export type { OptionPresentation } from "./ask";
