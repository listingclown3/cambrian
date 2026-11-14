/**
 * Results contract: files committed under results/, and the single Headline object the demo
 * and the pitch quote from.
 *
 * Honesty rule: a number is null until the experiment that produces it has actually run, and
 * `all_real` is true only when every non-null number came from real provider calls.
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

/** The headline numbers. Exactly these keys; null means "not run". */
export const HeadlineSchema = z.strictObject({
  /** Drex median decision latency, milliseconds. */
  drex_p50_ms: metric,
  /** Drex 95th percentile decision latency, milliseconds. */
  drex_p95_ms: metric,
  /** Claude median decision latency, milliseconds. */
  claude_p50_ms: metric,
  /** OpenAI median decision latency, milliseconds. */
  openai_p50_ms: metric,
  /** claude_p50_ms / drex_p50_ms. */
  latency_ratio_claude_over_drex: metric,
  /** openai_p50_ms / drex_p50_ms. */
  latency_ratio_openai_over_drex: metric,
  /** Drex cost per 1,000 decisions, US dollars. */
  drex_cost_per_1k_usd: metric,
  /** Claude cost per 1,000 decisions, US dollars. */
  claude_cost_per_1k_usd: metric,
  /** OpenAI cost per 1,000 decisions, US dollars. */
  openai_cost_per_1k_usd: metric,
  /** Fraction of unambiguous scenarios where Drex chose the answer-key best option. */
  top1_drex: metric,
  /** Same, for Claude. */
  top1_claude: metric,
  /** Same, for OpenAI. */
  top1_openai: metric,
  /** Same, for the scripted baseline. */
  top1_scripted: metric,
  /** Same, for uniform random choice. */
  top1_random: metric,
  /** Mean answer-key regret of Drex's choices, points. */
  regret_drex: metric,
  /** Same, for Claude. */
  regret_claude: metric,
  /** Same, for OpenAI. */
  regret_openai: metric,
  /** Same, for the scripted baseline. */
  regret_scripted: metric,
  /** Same, for uniform random choice. */
  regret_random: metric,
  /** Fraction of scenario families where Drex changed its answer correctly when the context flipped. */
  context_sensitivity_drex: metric,
  /** Same, for Claude. */
  context_sensitivity_claude: metric,
  /** Same, for OpenAI. */
  context_sensitivity_openai: metric,
  /** Drex top-1 with option labels anonymized (checks it reads descriptions, not label names). */
  top1_drex_anonymized: metric,
  /** Mean rollouts needed to find the best option when Drex's probabilities order the search. */
  rollouts_to_best_drex: metric,
  /** Same, with options searched in uniform random order. */
  rollouts_to_best_uniform: metric,
  /** Same, with Claude ordering the search. */
  rollouts_to_best_claude: metric,
  /** 100 * (1 - rollouts_to_best_drex / rollouts_to_best_uniform). */
  rollout_savings_pct_drex_vs_uniform: metric,
  /** Mean match margin of the Drex alliance with real-time latency charging on. */
  live_margin_drex_realtime: metric,
  /** Mean match margin of the Claude alliance with real-time latency charging on. */
  live_margin_claude_realtime: metric,
  /** Mean match margin of the Drex alliance with the match paused while it thinks. */
  live_margin_drex_paused: metric,
  /** Mean match margin of the Claude alliance with the match paused while it thinks. */
  live_margin_claude_paused: metric,
  /** Number of scenarios in the benchmark. */
  n_scenarios: metric,
  /** Number of scenario families. */
  n_families: metric,
  /** Number of eval seeds used for live matches. */
  n_live_seeds: metric,
  /** Simulated full matches per wall-clock second on this machine. */
  matches_per_sec: metric,
  /** True only if every non-null number above came from real (non-mock) provider calls. */
  all_real: z.boolean().nullable(),
});
export type Headline = z.infer<typeof HeadlineSchema>;

/** Every Headline key, in display order. */
export const HEADLINE_KEYS = Object.keys(HeadlineSchema.shape) as (keyof Headline)[];

/** A Headline with every value null: the state before any experiment has run. */
export function emptyHeadline(): Headline {
  return Object.fromEntries(HEADLINE_KEYS.map((k) => [k, null])) as Headline;
}
