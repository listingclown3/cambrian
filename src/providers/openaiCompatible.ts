/**
 * Generic OpenAI-compatible chat provider: any server that speaks POST {base}/chat/completions
 * (self-hosted vLLM or SGLang on a rented GPU, Ollama, OpenRouter, Together, DeepInfra, ...).
 *
 * It reuses the chat provider in ./deepinfra.ts; only the endpoint, model and key come from the
 * environment, so a new server needs no code change:
 *
 *   OPENAI_COMPATIBLE_BASE_URL=http://localhost:8000/v1   (no trailing /chat/completions)
 *   OPENAI_COMPATIBLE_MODEL=Qwen/Qwen3-8B
 *   OPENAI_COMPATIBLE_API_KEY=...                           (optional for local servers)
 *
 * Config (providers.byId.openai_compatible) supplies the defaults; the env values win.
 */
import type { Config, ProviderConfig } from "../contracts";

export const OPENAI_COMPATIBLE_ENV = {
  baseUrl: "OPENAI_COMPATIBLE_BASE_URL",
  model: "OPENAI_COMPATIBLE_MODEL",
} as const;

/** Provider config with the env overrides applied. endpoint/model stay null when neither source sets them. */
export function resolveOpenAICompatible(p: ProviderConfig, env: Record<string, string | undefined>): ProviderConfig {
  const base = env[OPENAI_COMPATIBLE_ENV.baseUrl]?.trim().replace(/\/+$/, "");
  const model = env[OPENAI_COMPATIBLE_ENV.model]?.trim();
  return {
    ...p,
    ...(base ? { endpoint: `${base}/chat/completions`, modelsEndpoint: `${base}/models` } : {}),
    ...(model ? { model } : {}),
  };
}

/** A config copy whose openai_compatible entry has the env overrides applied. */
export function withOpenAICompatible(cfg: Config, env: Record<string, string | undefined>): Config {
  const byId = cfg.providers.byId;
  return { ...cfg, providers: { ...cfg.providers, byId: { ...byId, openai_compatible: resolveOpenAICompatible(byId.openai_compatible, env) } } };
}
