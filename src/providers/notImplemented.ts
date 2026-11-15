/**
 * Placeholder for the network providers P2 has not written yet: drex, deepinfra, openai, gemini.
 *
 * It follows the provider contract (never throws; returns fallback answers with
 * meta.fallbackUsed = true and meta.error set), so callers can be written against it today and a
 * forgotten implementation is impossible to mistake for a real result.
 *
 * Implementation notes for P2:
 *   - drex (System 1): POST cfg.providers.byId.drex.endpoint with { model, state, questions };
 *             see the mapping table at the top of src/contracts/decide.ts. Auth: "Authorization:
 *             Bearer <NACE_API_KEY>". At most 512 questions per call. 422 is NOT retryable;
 *             for 429/500/503/529 honour Retry-After-Ms.
 *   - deepinfra (System 2): OpenAI-compatible chat completions. When cfg model is null, GET
 *             modelsEndpoint at startup, take the first available id in modelPreference, and log
 *             the exact id. temperature 0, the IDENTICAL stateText and options Drex gets,
 *             JSON-constrained answer, parse-retry once, then fall back.
 *   - openai / gemini: optional secondary baselines, only when their key is set; same prompt
 *             path as deepinfra.
 *   - all:    undici for HTTP, p-limit for cfg concurrency, timeoutMs per request, retries only
 *             in offline mode, cost from cfg.pricesPerMTokUsd, cache under cache/, and
 *             recordUsage() from src/ledger for every REAL call (never for cached or mock ones).
 */
import type { Config, DecisionProvider, DecisionRequest, DecisionResponse, ProviderId } from "../contracts";
import { fallbackResponse } from "./shared";

export function notImplementedProvider(id: ProviderId, cfg: Config): DecisionProvider {
  const model = cfg.providers.byId[id].model ?? "unknown";
  return {
    id,
    async decide(req: DecisionRequest): Promise<DecisionResponse> {
      return fallbackResponse(req, id, model, performance.now(), `provider "${id}" is not implemented yet (owner: P2)`);
    },
  };
}
