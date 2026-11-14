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
/** Files whose numbers are compared with each other: they must carry the current sim hash or they do not contribute. */
const SIM_FILES = new Set(["bench_scenarios", "bench_live", "bench_explore", "answerkey"]);
const currentSimHash = simHash(cfg);
const stale: { file: string; simHash: string | null }[] = [];
function results(name: string): any | null {
  if (seen.has(name)) return seen.get(name);
  const f = readJson("results", `${name}.json`);
  const isStale = !!f && SIM_FILES.has(name) && f.simHash !== currentSimHash;
  if (isStale) stale.push({ file: `results/${name}.json`, simHash: f.simHash ?? null });
  const use = f && !f.isMock && !isStale ? f : null;
  seen.set(name, use);
  if (!use) return null;
  contributing.push({ file: `results/${name}.json`, isMock: !!f.isMock, simHash: f.simHash ?? null, gitCommit: f.gitCommit ?? null });
  return use;
}

const bs = results("bench_scenarios")?.summary;
const live = results("bench_live")?.summary;
const explore = results("bench_explore")?.summary?.unambiguous;
const matches = results("matches")?.summary;
const batch = results("bench_batch")?.summary;
const lat = results("bench_latency")?.summary;
// Latency and cost: the quiet-window sequential run (bench_latency) when it has >= 10 good calls, else bench_scenarios (measured under load).
const smoke = results("smoke_latency")?.summary;
const pickNum = (o: any, ...ks: string[]) => { for (const k of ks) if (typeof o?.[k] === "number") return o[k] as number; return null; };
const smokeEntry = (id: string) => { const c = Array.isArray(smoke?.cells) ? smoke.cells.find((x: any) => x.spec === (id === "drex" ? "drex" : "deepinfra")) : null; return c && c.ok > 0 ? { p50: pickNum(c, "p50Ms"), p95: pickNum(c, "p95Ms"), cost: (pickNum(c, "costPerDecisionUsd") ?? pickNum(c, "costPerDecision")) !== null ? 1000 * (pickNum(c, "costPerDecisionUsd") ?? pickNum(c, "costPerDecision"))! : null, n: c.ok, models: c.models, fallbacks: c.fallbacks } : null; };
// Single-call latency and cost: the clean sequential measurement (smoke_latency, then bench_latency). The under-load bench_scenarios run is never used for headline latency.
const latOf = (id: string) => { const s = smokeEntry(id); if (s && s.p50 !== null) return { ...s, source: "results/smoke_latency.json (sequential, concurrency 1)" }; return lat?.[id] && lat[id].n_ok >= 10 && !lat[id].isMock ? { p50: lat[id].p50_ms, p95: lat[id].p95_ms, cost: lat[id].cost_per_1k_usd, source: "results/bench_latency.json (sequential, quiet window)", n: lat[id].n_ok } : null; };
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
  n_live_seeds: numberOrNull(live?.paired_drex_minus_giant?.realtime?.n),
  matches_per_sec: numberOrNull(cond("scripted_paused")?.matches_per_sec),
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
    stale_files_not_used: stale,
    current_sim_hash: currentSimHash,
    n_live_seeds_meaning: "paired eval seeds in the realtime Drex-vs-giant comparison; each condition has its own n in n.live_conditions",
    matches_per_sec_source: "1 / mean wall seconds of the scripted-vs-scripted reference matches in bench_live (AgentController, no model calls), same sim hash",
    live_fallbacks_and_exclusions: { per_condition: Object.fromEntries(Object.entries(live?.conditions ?? {}).map(([k, v]: [string, any]) => [k, { total: v.fallbacks_total, per_match: v.fallbacks_per_match }])), excluded_matches: results("bench_live")?.config?.excludedMatches ?? null, rule: results("bench_live")?.config?.exclusionRule ?? null },
    fairness_counters: { after_rules_eval: Object.fromEntries(Object.entries(live?.conditions ?? {}).map(([k, v]: [string, any]) => [k, { robot_decisions_per_match: v.mean_robot_decisions_per_match, running_actions_replaced_per_match: v.blue_running_actions_replaced_mean, behaviour_blue_mean_per_match: v.behaviour_blue_mean_per_match }])), before_rules_dev: ((): any => { const out: Record<string, unknown> = {}; for (const n of ["bench_live_drex_dev", "bench_live_giant_realtime_dev"]) { const f = readJson("results", n + ".json"); if (f) out[n] = { simHash: f.simHash, note: "rules off, dev seeds, earlier engine", rows: f.rows.map((r: any) => ({ timing: r.timing, seed: r.seed, robotDecisions: r.robotDecisions, replaced: r.blueRunningActionsReplaced, fallbacks: r.fallbacks, top: r.topChosenLabels?.[0] })) }; } return out; })() },
    batch_table: batch ? { simHash: seen.get("bench_batch")?.simHash ?? null, ms_per_decision: Object.fromEntries([1, 3, 8, 32].map((k) => [k, { drex: batch[`batch${k}_ms_per_decision_drex`] ?? null, giant: batch[`batch${k}_ms_per_decision_giant`] ?? null, drex_latest: batch[`batch${k}_ms_per_decision_drex_latest`] ?? null }])), agreement_with_single: batch.agreement_with_single ?? null, giant_batch8_p50_ms_range: batch.giant_batch8_p50_ms_range ?? null, incomplete_cells: batch.incomplete_cells ?? null } : null,
    live_check: ((): any => { const f = readJson("results", "bench_live_check.json"); if (!f || f.isMock) return null; return { note: "DECIDER PROPOSES, SIMULATOR CHECKS mode (off by default; run by the integrator). Never merged with the decider-alone live_margin_* numbers.", simHash: f.simHash, sameSimHash: f.simHash === currentSimHash, gitCommit: f.gitCommit, conditions: f.summary?.conditions ?? null, paired: f.summary?.paired ?? null }; })(),
    speed_headline: batch ? { label: "per decision, one alliance batched (3 questions per call)", batch3_ms_per_decision: { drex: batch.batch3_ms_per_decision_drex ?? null, giant: batch.batch3_ms_per_decision_giant ?? null }, single_question_ms_per_decision: { drex: batch.batch1_ms_per_decision_drex ?? null, giant: batch.batch1_ms_per_decision_giant ?? null }, batch8_stress_ms_per_decision: { drex: batch.batch8_ms_per_decision_drex ?? null, giant: batch.batch8_ms_per_decision_giant ?? null, giant_note: "P2 saw the giant at batch 8 vary between 491 and 1362 ms per decision across runs; report the range" }, ratio_batch3: batch.batch3_ms_per_decision_giant && batch.batch3_ms_per_decision_drex ? Number((batch.batch3_ms_per_decision_giant / batch.batch3_ms_per_decision_drex).toFixed(1)) : null } : null,
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
