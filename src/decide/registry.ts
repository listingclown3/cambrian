/**
 * Provider registry (owner: P2): the one place a provider id is turned into a DecisionProvider.
 *
 *   getProvider("drex", cfg)                       drex at cfg model (drex-v2.0)
 *   getProvider("drex", cfg, { model: "drex-latest" })
 *   getProviderBySpec("drex:drex-latest", cfg)     same, from a CLI-style spec "id[:model]"
 *   getProviderBySpec("deepinfra:Qwen/Qwen3.8-27B", cfg)
 *
 * Without options, instances are shared per config object, so the DeepInfra model list is
 * fetched once and the concurrency limit is shared.
 */
import { ProviderIdSchema, type Config, type DecisionProvider, type ProviderId } from "../contracts";
import { randomProvider, scriptedProvider } from "./providers/baselines";
import { chatProvider, deepinfraProvider, type ChatProviderOptions } from "./providers/deepinfra";
import { drexProvider } from "./providers/drex";
import { drexMockProvider } from "./providers/drexMock";
import { notImplementedProvider } from "./providers/notImplemented";

/** Provider ids that have a real implementation today. Add to this as providers land. */
export const IMPLEMENTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["drex_mock", "scripted", "random", "drex", "deepinfra"]);

/** Ids whose provider makes real network calls. */
export const NETWORK_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["drex", "deepinfra", "openai", "gemini"]);

/** Options for network providers: a model override plus the test/tool seams. */
export type ProviderOptions = ChatProviderOptions;

const shared = new WeakMap<Config, Map<ProviderId, DecisionProvider>>();

function build(id: ProviderId, cfg: Config, opts: ProviderOptions): DecisionProvider {
  switch (id) {
    case "drex_mock":
      return drexMockProvider;
    case "random":
      return randomProvider;
    case "scripted":
      return scriptedProvider;
    case "drex":
      return drexProvider(cfg, opts);
    case "deepinfra":
      return deepinfraProvider(cfg, opts);
    case "openai": {
      // Optional secondary baseline: only when its key is set AND a model id is configured.
      const env = opts.env ?? process.env;
      const p = cfg.providers.byId.openai;
      const model = opts.model ?? p.model;
      if (env[p.apiKeyEnv ?? ""] && model && !model.startsWith("TODO_")) return chatProvider("openai", cfg, { ...opts, model });
      return notImplementedProvider(id, cfg);
    }
    case "gemini":
      return notImplementedProvider(id, cfg);
  }
}

/** Get the provider for an id. Unimplemented network providers return flagged fallback answers. */
export function getProvider(id: ProviderId, cfg: Config, opts?: ProviderOptions): DecisionProvider {
  if (opts && Object.keys(opts).length > 0) return build(id, cfg, opts);
  let byId = shared.get(cfg);
  if (!byId) shared.set(cfg, (byId = new Map()));
  let provider = byId.get(id);
  if (!provider) byId.set(id, (provider = build(id, cfg, {})));
  return provider;
}

/**
 * Split "id[:model][@think]" (the model may contain ":" or "/"). "@think" turns reasoning on for
 * chat providers. Throws on an unknown id.
 */
export function parseProviderSpec(spec: string): { id: ProviderId; model?: string; thinking?: "on" } {
  const think = spec.endsWith("@think");
  const base = think ? spec.slice(0, -"@think".length) : spec;
  const i = base.indexOf(":");
  const id = ProviderIdSchema.parse(i < 0 ? base : base.slice(0, i));
  const model = i < 0 ? undefined : base.slice(i + 1) || undefined;
  return { id, ...(model ? { model } : {}), ...(think ? { thinking: "on" as const } : {}) };
}

/** Get a provider from a spec such as "drex", "drex:drex-latest", "deepinfra@think" or "deepinfra:Qwen/Qwen3.8-27B". */
export function getProviderBySpec(spec: string, cfg: Config, opts: ProviderOptions = {}): DecisionProvider {
  const { id, model, thinking } = parseProviderSpec(spec);
  const merged: ProviderOptions = { ...opts, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  return getProvider(id, cfg, merged);
}
