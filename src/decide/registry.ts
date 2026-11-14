/**
 * Provider registry (owner: P2): the one place a provider id is turned into a DecisionProvider.
 */
import type { Config, DecisionProvider, ProviderId } from "../contracts";
import { randomProvider, scriptedProvider } from "./providers/baselines";
import { drexMockProvider } from "./providers/drexMock";
import { notImplementedProvider } from "./providers/notImplemented";

/** Provider ids that have a real implementation today. Add to this as providers land. */
export const IMPLEMENTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["drex_mock", "scripted", "random"]);

/** Get the provider for an id. Unimplemented network providers return flagged fallback answers. */
export function getProvider(id: ProviderId, cfg: Config): DecisionProvider {
  switch (id) {
    case "drex_mock":
      return drexMockProvider;
    case "random":
      return randomProvider;
    case "scripted":
      return scriptedProvider;
    case "drex":
    case "claude":
    case "openai":
    case "gemini":
      return notImplementedProvider(id, cfg);
  }
}
