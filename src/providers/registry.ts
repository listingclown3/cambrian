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
import { randomProvider, scriptedProvider } from "./baselines";
import { chatProvider, deepinfraProvider, type ChatDecisionProvider, type ChatProviderOptions } from "./deepinfra";
import { drexProvider } from "./drex";
import { DREX_MOCK_MODEL, drexMockProvider } from "./drexMock";
import { notImplementedProvider } from "./notImplemented";
import { anonymizedProvider } from "./anonymize";
import { cachedProvider } from "./cache";

/** Provider ids that have a real implementation today. Add to this as providers land. */
export const IMPLEMENTED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["drex_mock", "scripted", "random", "drex", "deepinfra"]);

/** Ids whose provider makes real network calls. */
export const NETWORK_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["drex", "deepinfra", "openai", "gemini"]);

/** Options for network providers: a model override plus the test/tool seams. */
export interface ProviderOptions extends ChatProviderOptions {
  /** drex only: serving host ("console" default, or a key of providers.byId.drex.hosts). */
  host?: string;
  /** Answer identical OFFLINE requests from cache/decide (see cache.ts). Default false. */
  cache?: boolean | { dir?: string };
  /** Anonymized-labels ablation: options are shown as opt_01.. with descriptions kept (see anonymize.ts). */
  anonymize?: boolean;
}

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
  if (opts && Object.keys(opts).length > 0) {
    const { cache, anonymize, ...rest } = opts;
    let provider = build(id, cfg, rest);
    if (cache && NETWORK_PROVIDERS.has(id)) {
      const resolve = (provider as Partial<ChatDecisionProvider>).resolveModel;
      const model = resolve ? () => resolve() : (rest.model ?? cfg.providers.byId[id].model ?? "default");
      const variant = id === "drex" ? `host=${rest.host ?? "console"}` : `thinking=${rest.thinking ?? "off"};split=${rest.splitQuestions ?? true};max=${rest.maxTokens ?? 4096}`;
      provider = cachedProvider(provider, { model, variant, ...(typeof cache === "object" && cache.dir ? { dir: cache.dir } : {}) });
    }
    return anonymize ? anonymizedProvider(provider) : provider;
  }
  let byId = shared.get(cfg);
  if (!byId) shared.set(cfg, (byId = new Map()));
  let provider = byId.get(id);
  if (!provider) byId.set(id, (provider = build(id, cfg, {})));
  return provider;
}

/**
 * The exact model id a provider will use, for run manifests: the resolved DeepInfra id, the
 * requested Drex model, or a fixed name for local providers.
 */
export async function providerModel(provider: DecisionProvider, cfg: Config): Promise<string> {
  const p = provider as { model?: string; resolveModel?: () => Promise<string | null> };
  if (p.resolveModel) return (await p.resolveModel()) ?? "unresolved";
  if (p.model) return p.model;
  if (provider.id === "drex_mock") return DREX_MOCK_MODEL;
  return cfg.providers.byId[provider.id].model ?? provider.id;
}

/** Reasoning setting of a chat provider ("off" | "on" | "default"); null for providers without one (Drex, local). */
export function providerReasoning(provider: DecisionProvider): "off" | "on" | "default" | null {
  const r = (provider as { reasoning?: string }).reasoning;
  return r === "off" || r === "on" || r === "default" ? r : null;
}

/**
 * The model label used in manifests and results: the exact model id, plus " (reasoning off)" /
 * " (reasoning on)" for chat providers, e.g. "Qwen/Qwen3.5-397B-A17B (reasoning off)".
 * DecisionMeta.model stays the bare exact id (it keys prices and caches).
 */
export async function providerLabel(provider: DecisionProvider, cfg: Config): Promise<string> {
  const model = await providerModel(provider, cfg);
  const r = providerReasoning(provider);
  return r === null ? model : `${model} (reasoning ${r})`;
}

/** Warm a provider's connection before a match (Drex only; a no-op elsewhere). Never throws. */
export async function warmupProvider(provider: DecisionProvider): Promise<void> {
  const w = (provider as { warmup?: () => Promise<unknown> }).warmup;
  if (!w) return;
  try {
    await w();
  } catch {
    /* warm-up is best effort */
  }
}

/** Flags a spec may carry after "@", in any order: "drex:drex-latest@anon@cache". */
const SPEC_FLAGS = ["think", "anon", "cache", "di"] as const;

/**
 * Split "id[:model][@flag...]" (the model may contain ":" or "/"). Flags:
 *   @think  reasoning on (chat providers)
 *   @anon   anonymized-labels ablation (labels shown as opt_01.., descriptions kept)
 *   @cache  offline response cache (offline requests only)
 *   @di     drex only: served by DeepInfra's Decisions API (host "deepinfra") instead of console.nace.ai
 * Throws on an unknown id or flag.
 */
export function parseProviderSpec(spec: string): { id: ProviderId; model?: string; thinking?: "on"; anonymize?: true; cache?: true; host?: string } {
  const [base, ...flags] = spec.split("@");
  for (const f of flags) if (!(SPEC_FLAGS as readonly string[]).includes(f)) throw new Error(`unknown provider spec flag "@${f}" in "${spec}"`);
  const i = base!.indexOf(":");
  const id = ProviderIdSchema.parse(i < 0 ? base : base!.slice(0, i));
  const model = i < 0 ? undefined : base!.slice(i + 1) || undefined;
  return {
    id,
    ...(model ? { model } : {}),
    ...(flags.includes("think") ? { thinking: "on" as const } : {}),
    ...(flags.includes("anon") ? { anonymize: true as const } : {}),
    ...(flags.includes("cache") ? { cache: true as const } : {}),
    ...(flags.includes("di") ? { host: "deepinfra" } : {}),
  };
}

/**
 * Get a provider from a spec such as "drex", "drex:drex-latest", "deepinfra@think",
 * "deepinfra:Qwen/Qwen3.8-27B" or "drex@anon@cache".
 */
export function getProviderBySpec(spec: string, cfg: Config, opts: ProviderOptions = {}): DecisionProvider {
  const { id, ...rest } = parseProviderSpec(spec);
  return getProvider(id, cfg, { ...opts, ...rest });
}
