/**
 * Placeholder for the network providers P2 has not written yet: drex, claude, openai, gemini.
 *
 * It follows the provider contract (never throws; returns fallback answers with
 * meta.fallbackUsed = true and meta.error set), so callers can be written against it today and a
 * forgotten implementation is impossible to mistake for a real result.
 *
 * Implementation notes for P2:
 *   - drex:   POST cfg.providers.byId.drex.endpoint with { model, state, questions }; see the
 *             mapping table at the top of src/contracts/decide.ts. Auth: "Authorization: Bearer
 *             <NACE_API_KEY>". Errors: 401/402/422/429/500/503/529; honour Retry-After-Ms.
 *   - claude / openai / gemini: render the same questions into one prompt and force a
 *             closed-choice answer (structured output / tool call), then validate the label.
 *   - all:    undici for HTTP, p-limit for cfg concurrency, timeoutMs per request, retries only
 *             in offline mode, cost from cfg.pricesPerMTokUsd, cache under cache/.
 */
import type { Config, DecisionProvider, DecisionRequest, DecisionResponse, ProviderId } from "../../contracts";
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
