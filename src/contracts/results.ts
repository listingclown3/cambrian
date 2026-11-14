/**
 * Results contract: files committed under results/, and the single Headline object the demo
 * and the pitch quote from.
 *
 * Honesty rule: a number is null until the experiment that produces it has actually run, and
 * `all_real` is true only when every non-null number came from real provider calls.
 *
 * Naming: "drex" is System 1 (Nace's decision model); "deepinfra" is System 2 (a large LLM on
 * DeepInfra), the giant Drex is compared against; "openai" is an optional secondary baseline.
 */
import { z } from "zod";

/** One results file: one experiment, its rows, and its summary. */
export const ResultsFileSchema = z.object({
  /** Experiment name (for example "bench_scenarios"). Also the file stem under results/. */
  experiment: z.string().min(1),
  /** When the file was written, ISO 8601 UTC. */
  createdTs: z.string(),
  /** True if any row came from mock or synthetic answers. */
  isMock: z.boolean(),
  /** Git commit the results were produced at. */
  gitCommit: z.string(),
  /** Sim hash the results were produced with. */
  simHash: z.string(),
  /** Config used (the full Config object, or the subset relevant to the experiment). */
  config: z.unknown(),
  /** One object per measured unit (scenario x provider, match, etc.). */
  rows: z.array(z.record(z.string(), z.unknown())),
  /** Aggregates computed from rows. */
  summary: z.record(z.string(), z.unknown()),
});
export type ResultsFile = z.infer<typeof ResultsFileSchema>;

const metric = z.number().nullable();

/**
 * The headline numbers. Exactly these keys, in presentation order; null means "not run".
 * Order: live latency-charged margin, then latency and cost, then decision quality, then rollout
 * savings, then sizes, then tool usage.
 */
export const HeadlineSchema = z.strictObject({
  // ── 1. real-time sim margin: matches where thinking time runs on the sim clock ──
  // On-screen label for the live_margin_* keys: "real-time sim margin (thinking time on the sim clock)".
  /** Mean match margin of the Drex alliance with real-time latency charging on. */
  live_margin_drex_realtime: metric,
  /** Mean match margin of the DeepInfra alliance with real-time latency charging on. */
  live_margin_deepinfra_realtime: metric,
  /** Mean match margin of the Drex alliance with the match paused while it thinks. */
  live_margin_drex_paused: metric,
  /** Mean match margin of the DeepInfra alliance with the match paused while it thinks. */
  live_margin_deepinfra_paused: metric,

  // ── 2. latency and cost ───────────────────────────────────────────────────
  /** Drex median decision latency, milliseconds. */
  drex_p50_ms: metric,
  /** Drex 95th percentile decision latency, milliseconds. */
  drex_p95_ms: metric,
  /** DeepInfra median decision latency, milliseconds. */
  deepinfra_p50_ms: metric,
  /** OpenAI median decision latency, milliseconds. */
  openai_p50_ms: metric,
  /** deepinfra_p50_ms / drex_p50_ms. */
  latency_ratio_deepinfra_over_drex: metric,
  /** openai_p50_ms / drex_p50_ms. */
  latency_ratio_openai_over_drex: metric,
  /** Drex cost per 1,000 decisions, US dollars. */
  drex_cost_per_1k_usd: metric,
  /** DeepInfra cost per 1,000 decisions, US dollars. */
  deepinfra_cost_per_1k_usd: metric,
  /** OpenAI cost per 1,000 decisions, US dollars. */
  openai_cost_per_1k_usd: metric,

  // ── 3. decision quality against the answer key ────────────────────────────
  /** Fraction of unambiguous scenarios where Drex chose the answer-key best option. */
  top1_drex: metric,
  /** Same, for DeepInfra. */
  top1_deepinfra: metric,
  /** Same, for OpenAI. */
  top1_openai: metric,
  /** Same, for the scripted baseline. */
  top1_scripted: metric,
  /** Same, for uniform random choice. */
  top1_random: metric,
  /** Mean answer-key regret of Drex's choices, points. */
  regret_drex: metric,
  /** Same, for DeepInfra. */
  regret_deepinfra: metric,
  /** Same, for OpenAI. */
  regret_openai: metric,
  /** Same, for the scripted baseline. */
  regret_scripted: metric,
  /** Same, for uniform random choice. */
  regret_random: metric,
  /** Fraction of scenario families where Drex changed its answer correctly when the context flipped. */
  context_sensitivity_drex: metric,
  /** Same, for DeepInfra. */
  context_sensitivity_deepinfra: metric,
  /** Same, for OpenAI. */
  context_sensitivity_openai: metric,
  /** Drex top-1 with option labels anonymized (checks it reads descriptions, not label names). */
  top1_drex_anonymized: metric,

  // ── 4. rollout savings ────────────────────────────────────────────────────
  /** Mean rollouts needed to find the best option when Drex's probabilities order the search. */
  rollouts_to_best_drex: metric,
  /** Same, with options searched in uniform random order. */
  rollouts_to_best_uniform: metric,
  /** Same, with DeepInfra ordering the search. */
  rollouts_to_best_deepinfra: metric,
  /** 100 * (1 - rollouts_to_best_drex / rollouts_to_best_uniform). */
  rollout_savings_pct_drex_vs_uniform: metric,

  // ── sizes ─────────────────────────────────────────────────────────────────
  /** Number of scenarios in the benchmark. */
  n_scenarios: metric,
  /** Number of scenario families. */
  n_families: metric,
  /** Number of eval seeds used for live matches. */
  n_live_seeds: metric,
  /** Simulated full matches per wall-clock second on this machine (scripted controllers, no model calls). */
  matches_per_sec: metric,
  /** Full simulated matches per hour with Drex making every decision (measured wall time per match). */
  sim_matches_per_hour_drex: metric,
  /** Full simulated matches per hour with the DeepInfra giant making every decision. */
  sim_matches_per_hour_deepinfra: metric,

  // ── tool usage (from the usage ledger; real calls only) ───────────────────
  /** Questions answered by Drex. */
  usage_drex_questions: metric,
  /** Documents processed by NDI. */
  usage_ndi_docs: metric,
  /** Pages processed by NDI. */
  usage_ndi_pages: metric,
  /** Intern sessions run. */
  usage_intern_sessions: metric,
  /** System 1 (Drex) supervisor judgments made inside Intern sessions. */
  usage_intern_system1_judgments: metric,
  /** DeepInfra chat completion calls. */
  usage_deepinfra_calls: metric,
  /** Keenable search and fetch requests. */
  usage_keenable_requests: metric,
  /** Strategy proposals produced by the Strategy Lab that passed validation. */
  lab_proposals_total: metric,
  /** Of those, how many beat the scripted baseline in simulation. */
  lab_proposals_beating_baseline: metric,
  /** Web pages saved by Keenable research. */
  keenable_pages: metric,
  /** Percentage of game/field config constants verified against the manual by NDI-extracted rules. */
  ndi_rules_verified_pct: metric,

  /** True only if every non-null number above came from real (non-mock) provider calls. */
  all_real: z.boolean().nullable(),
});
export type Headline = z.infer<typeof HeadlineSchema>;

/** Every Headline key, in presentation order. */
export const HEADLINE_KEYS = Object.keys(HeadlineSchema.shape) as (keyof Headline)[];

/** A Headline with every value null: the state before any experiment has run. */
export function emptyHeadline(): Headline {
  return Object.fromEntries(HEADLINE_KEYS.map((k) => [k, null])) as Headline;
}
