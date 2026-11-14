/**
 * Decision layer entry point (owner: P2): providers, registry, request building.
 */
export { IMPLEMENTED_PROVIDERS, getProvider } from "./registry";
export { ACTION_QUESTION_ID, buildActionRequest, chosenIntent, chosenOption } from "./ask";
export { renderStateText } from "./stateText";
export { drexMockProvider, DREX_MOCK_MODEL } from "./providers/drexMock";
export { randomProvider, scriptedProvider } from "./providers/baselines";
export { defaultAnswer, fallbackResponse, localMeta } from "./providers/shared";
