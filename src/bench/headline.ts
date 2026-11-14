/**
 * pnpm headline (owner: P3)
 * Assemble the Headline numbers from the results files and write results/headline.json.
 *
 *   usage_*                 <- the usage ledger (runs/usage.jsonl)
 *   keenable_pages          <- data/research/sources.json
 *   ndi_rules_verified_pct  <- results/ingest_rules.json
 *   live_margin_*, n_live_seeds, sim_matches_per_hour_*  <- results/bench_live.json
 *   *_p50_ms, *_p95_ms, *_cost_per_1k_usd, top1_*, regret_*, context_sensitivity_*,
 *   top1_drex_anonymized, n_scenarios, n_families           <- results/bench_scenarios.json
 *   rollouts_to_best_*, rollout_savings_pct_drex_vs_uniform <- results/bench_explore.json
 *   matches_per_sec                                          <- results/matches.json
 *   batch*_ms_per_decision_* (when in the Headline contract) <- results/bench_batch.json
 *   lab_proposals_*                                          <- results/lab.json
 * A results file contributes only when it exists and is not mock; a key whose experiment did not
 * run stays null. all_real is true only if no contributing file is mock (mock files never
 * contribute, so it is false only when a mock file was found and skipped).
 * Latencies are round trip (request sent to answer parsed). The giant is the DeepInfra model with
 * reasoning OFF; reasoning-on numbers are reported separately in this file's config, never mixed in.
 */
import { existsSync, readFileSync } from "node:fs";
import { HeadlineSchema, emptyHeadline } from "../contracts";
import { readUsage, summarizeUsage, usageHeadline } from "../ledger";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

const cfg = loadConfig();
const readJson = (...parts: string[]): any | null => (existsSync(repoPath(...parts)) ? JSON.parse(readFileSync(repoPath(...parts), "utf8")) : null);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? Number((a / b).toFixed(2)) : null);

const sources = readJson("data", "research", "sources.json");
const ingestRules = readJson("results", "ingest_rules.json");

const contributing: { file: string; isMock: boolean; simHash: string | null; gitCommit: string | null }[] = [];
/** Read results/<name>.json; returns null (and records it) when it is mock. */
const seen = new Map<string, any>();
function results(name: string): any | null {
  if (seen.has(name)) return seen.get(name);
  const f = readJson("results", `${name}.json`);
  seen.set(name, f && !f.isMock ? f : null);
  if (!f) return null;
  contributing.push({ file: `results/${name}.json`, isMock: !!f.isMock, simHash: f.simHash ?? null, gitCommit: f.gitCommit ?? null });
  return f.isMock ? null : f;
}

const bs = results("bench_scenarios")?.summary;
const live = results("bench_live")?.summary;
const explore = results("bench_explore")?.summary?.unambiguous;
const matches = results("matches")?.summary;
const batch = results("bench_batch")?.summary;
const lat = results("bench_latency")?.summary;
// Latency and cost: the quiet-window sequential run (bench_latency) when it has >= 10 good calls, else bench_scenarios (measured under load).
const latOf = (id: string) => (lat?.[id] && lat[id].n_ok >= 10 && !lat[id].isMock ? { p50: lat[id].p50_ms, p95: lat[id].p95_ms, cost: lat[id].cost_per_1k_usd, source: "results/bench_latency.json (sequential, quiet window)", n: lat[id].n_ok } : d(id) ? { p50: d(id).latency_p50_ms, p95: d(id).latency_p95_ms, cost: d(id).cost_per_1k_usd, source: "results/bench_scenarios.json (measured under load)", n: d(id).n_scored } : null);
const lab = results("lab")?.summary;
const d = (id: string) => bs?.deciders?.[id] ?? null;
const cond = (id: string) => live?.conditions?.[id] ?? null;

const drexP50 = numberOrNull(latOf("drex")?.p50);
const giantP50 = numberOrNull(latOf("deepinfra")?.p50);
const values: Record<string, number | null> = {
  live_margin_drex_realtime: numberOrNull(cond("drex_realtime")?.mean_margin),
  live_margin_deepinfra_realtime: numberOrNull(cond("deepinfra_realtime")?.mean_margin),
  live_margin_drex_paused: numberOrNull(cond("drex_paused")?.mean_margin),
  live_margin_deepinfra_paused: numberOrNull(cond("deepinfra_paused")?.mean_margin),
  drex_p50_ms: drexP50,
  drex_p95_ms: numberOrNull(latOf("drex")?.p95),
  deepinfra_p50_ms: giantP50,
  latency_ratio_deepinfra_over_drex: ratio(giantP50, drexP50),
  drex_cost_per_1k_usd: numberOrNull(latOf("drex")?.cost),
  deepinfra_cost_per_1k_usd: numberOrNull(latOf("deepinfra")?.cost),
  top1_drex: numberOrNull(d("drex")?.top1),
  top1_deepinfra: numberOrNull(d("deepinfra")?.top1),
  top1_scripted: numberOrNull(d("scripted")?.top1),
  top1_random: numberOrNull(d("random")?.top1),
  regret_drex: numberOrNull(d("drex")?.regret),
  regret_deepinfra: numberOrNull(d("deepinfra")?.regret),
  regret_scripted: numberOrNull(d("scripted")?.regret),
  regret_random: numberOrNull(d("random")?.regret),
  context_sensitivity_drex: numberOrNull(d("drex")?.context_sensitivity?.fraction_families),
  context_sensitivity_deepinfra: numberOrNull(d("deepinfra")?.context_sensitivity?.fraction_families),
  top1_drex_anonymized: numberOrNull(d("drex_anon")?.top1),
  rollouts_to_best_drex: numberOrNull(explore?.rollouts_to_best_drex),
  rollouts_to_best_uniform: numberOrNull(explore?.rollouts_to_best_uniform),
  rollouts_to_best_deepinfra: numberOrNull(explore?.rollouts_to_best_deepinfra),
  rollout_savings_pct_drex_vs_uniform: numberOrNull(explore?.rollout_savings_pct_drex_vs_uniform),
  n_scenarios: numberOrNull(bs?.n_scenarios),
  n_families: numberOrNull(bs?.n_families),
  n_live_seeds: live ? numberOrNull(Math.min(...["drex_realtime", "drex_paused", "deepinfra_realtime", "deepinfra_paused"].map((k) => cond(k)?.n ?? Infinity))) : null,
  matches_per_sec: numberOrNull(matches?.matches_per_sec),
  sim_matches_per_hour_drex: numberOrNull(cond("drex_paused")?.sim_matches_per_hour),
  sim_matches_per_hour_deepinfra: numberOrNull(cond("deepinfra_paused")?.sim_matches_per_hour),
  lab_proposals_total: numberOrNull(lab?.lab_proposals_total),
  lab_proposals_beating_baseline: numberOrNull(lab?.lab_proposals_beating_baseline),
};
for (const size of [1, 3, 8, 32]) {
  for (const who of ["drex", "giant"]) {
    const key = `batch${size}_ms_per_decision_${who}`;
    values[key] = numberOrNull(batch?.[key]);
  }
}
// Only keys the Headline contract has (the batch keys exist once main's contract is merged).
const shape = HeadlineSchema.shape as Record<string, unknown>;
const known = Object.fromEntries(Object.entries(values).filter(([k]) => k in shape));
const anyMock = contributing.some((c) => c.isMock);

const headline = HeadlineSchema.parse({
  ...emptyHeadline(),
  ...usageHeadline(summarizeUsage(readUsage(cfg))),
  keenable_pages: numberOrNull(sources?.pages),
  ndi_rules_verified_pct: ingestRules?.isMock === false ? numberOrNull(ingestRules.summary?.ndi_rules_verified_pct) : null,
  ...known,
  all_real: !anyMock,
});
const nOf = (id: string) => d(id)?.n_unambiguous_scored ?? null;
const file = writeResults({
  experiment: "headline",
  createdTs: new Date().toISOString(),
  isMock: anyMock,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: {
    contributing,
    simHashesConsistent: new Set(contributing.map((c) => c.simHash).filter(Boolean).flatMap((h) => String(h).split(","))).size <= 1,
    models: {
      drex: d("drex")?.models ?? null,
      drex_latest: d("drex-latest")?.models ?? null,
      giant: d("deepinfra")?.models ?? null,
      giant_reasoning: "off (main comparison; the giant's fastest setting)",
      live: Object.fromEntries(Object.entries(live?.conditions ?? {}).map(([k, v]: [string, any]) => [k, v.models])),
    },
    latency_sources: { drex: latOf("drex"), deepinfra: latOf("deepinfra") },
    regret_with_ci: Object.fromEntries(Object.entries(bs?.deciders ?? {}).map(([k, v]: [string, any]) => [k, { regret: v.regret, ci95: v.regret_ci95 ?? null, n: v.n_regret ?? v.n_scored }])),
    paired_regret: bs?.paired_regret ?? null,
    degeneracy_gate: bs?.degeneracy_gate ?? null,
    answers_source: results("bench_scenarios")?.config?.answersSource ?? null,
    live_paired_vs_scripted: live?.paired_vs_scripted_control ?? null,
    live_wall_ms_per_robot_decision: Object.fromEntries(Object.entries(live?.conditions ?? {}).map(([k, v]: [string, any]) => [k, v.wall_ms_per_robot_decision ?? null])),
    latency: "round trip p50/p95 (request sent to answer parsed, retries included); Drex's own server-side evaluation time is not used",
    n: {
      top1_unambiguous_scored: { drex: nOf("drex"), deepinfra: nOf("deepinfra"), scripted: nOf("scripted"), random: nOf("random"), drex_anon: nOf("drex_anon") },
      live_conditions: Object.fromEntries(Object.entries(live?.conditions ?? {}).map(([k, v]: [string, any]) => [k, { n: v.n, mean_margin: v.mean_margin, ci95: v.ci95, fallbacks: v.fallbacks_total, robot_decisions_per_match: v.mean_robot_decisions_per_match, wall_s_per_match: v.mean_wall_s_per_match }])),
      live_paired_drex_minus_giant: live?.paired_drex_minus_giant ?? null,
      rollouts_to_best_n_scenarios: explore?.n ?? null,
    },
    fallbacks: Object.fromEntries(Object.entries(bs?.deciders ?? {}).map(([k, v]: [string, any]) => [k, { final: v.fallbacks, first_pass: v.fallbacks_first_pass ?? null }])),
    giant_reasoning_on_separate: d("deepinfra_think")
      ? { label: `giant with reasoning on (n = ${d("deepinfra_think").n_asked})`, models: d("deepinfra_think").models, top1: d("deepinfra_think").top1, n_unambiguous_scored: nOf("deepinfra_think"), regret: d("deepinfra_think").regret, p50_ms: d("deepinfra_think").latency_p50_ms, p95_ms: d("deepinfra_think").latency_p95_ms, cost_per_1k_usd: d("deepinfra_think").cost_per_1k_usd, fallbacks: d("deepinfra_think").fallbacks, match_estimate_calculation: live?.giant_reasoning_on_match_estimate ?? null }
      : null,
    drex_latest_separate: d("drex-latest") ? { top1: d("drex-latest").top1, regret: d("drex-latest").regret, p50_ms: d("drex-latest").latency_p50_ms, cost_per_1k_usd: d("drex-latest").cost_per_1k_usd } : null,
    not_run: ["openai baseline (cut)"],
  },
  rows: [],
  summary: headline,
});
const filled = Object.entries(headline).filter(([, v]) => v !== null);
console.log(`[headline] ${filled.length} of ${Object.keys(headline).length} numbers filled.`);
for (const [key, value] of Object.entries(headline)) console.log(`  ${key} = ${value}`);
console.log(`[headline] wrote ${file}`);
