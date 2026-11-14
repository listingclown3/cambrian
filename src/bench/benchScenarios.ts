/**
 * pnpm bench:scenarios [-- --skip-think] (owner: P3)
 * Ask every decider every scenario with the IDENTICAL request (scenarioRequest in common.ts:
 * the focus robot's observation view rendered by src/decide/ask.ts, with the scenario's curated
 * options). Deciders never see the answer key.
 *
 * Deciders:
 *   drex              drex-v2.0 (config default)            System 1
 *   drex:drex-latest  drex-latest (alias of drex-max-v1.1)  System 1
 *   drex_anon         drex-v2.0 with labels anonymized (opt_01..; descriptions unchanged)
 *   deepinfra         the giant, reasoning OFF (its fastest setting; the main comparison)
 *   deepinfra@think   the giant, reasoning ON, only on the first 8 unambiguous scenarios by id
 *                     (fixed subset), reported separately and never mixed into the main numbers
 *   scripted          basic_cycle policy applied to the scenario view (free baseline)
 *   random            uniform random over the options (free baseline)
 * Network deciders are asked one request at a time (concurrency 1) so round-trip latency is not
 * inflated by bursts; reasoning-on uses 4 concurrent requests (its latency is per call anyway).
 *
 * Scores: top-1 on unambiguous scenarios, mean regret (best mean minus chosen mean) on all,
 * context sensitivity per family, round-trip latency p50/p95 from meta.latencyMs, cost per
 * 1,000 decisions from meta.costUsd. Fallback answers are counted and NOT scored.
 *
 * Writes results/bench_scenarios.json, results/scenarios.json (UI + lab) and a run log.
 */
import "dotenv/config";
import pLimit from "p-limit";
import type { DecisionMeta, DecisionResponse, Scenario } from "../contracts";
import { chosenOption } from "../decide/ask";
import { getProviderBySpec } from "../decide/registry";
import { ENGINE_IS_STUB, engine } from "../engine";
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { RunLogger, buildManifest, newRunId, writeResults } from "../util/runLog";
import { anonymize, writeJson, loadScenarioSet, mean, pct, round, scenarioRequest, scriptedLabelFor, SCENARIO_REQUEST_SEED } from "./common";

const cfg = loadConfig();
const set = loadScenarioSet();
const scenarios = set.scenarios.filter((s) => s.answerKey);
if (scenarios.length !== set.scenarios.length) throw new Error("some scenarios have no answer key: run pnpm answerkey first");
const skipThink = process.argv.includes("--skip-think");
const runId = newRunId("bench_scenarios");
const logger = new RunLogger(runId);
logger.write({ type: "run_start", isMock: false, manifest: buildManifest({ runId, cfg, seeds: { dev: [], eval: [] }, provider: "mixed", model: "mixed", isMock: false }) });

interface Answer {
  scenarioId: string;
  label: string | null;
  probabilities: Record<string, number> | null;
  meta: DecisionMeta | null;
}

const thinkSubset = scenarios.filter((s) => !s.answerKey!.ambiguous).map((s) => s.id).sort().slice(0, 8);

type Decider = { id: string; spec: string | null; subset?: string[]; anon?: boolean; concurrency: number };
const DECIDERS: Decider[] = [
  { id: "drex", spec: "drex", concurrency: 1 },
  { id: "drex-latest", spec: "drex:drex-latest", concurrency: 1 },
  { id: "drex_anon", spec: "drex", anon: true, concurrency: 1 },
  { id: "deepinfra", spec: "deepinfra", concurrency: 1 },
  ...(skipThink ? [] : [{ id: "deepinfra_think", spec: "deepinfra@think", subset: thinkSubset, concurrency: 4 }]),
  { id: "scripted", spec: null, concurrency: 1 },
  { id: "random", spec: "random", concurrency: 1 },
];

async function ask(d: Decider, s: Scenario): Promise<Answer> {
  if (d.spec === null) {
    const label = scriptedLabelFor(engine.restore(s.snapshot), s.focusRobotId, s.options);
    return { scenarioId: s.id, label, probabilities: null, meta: { provider: "scripted", model: "basic_cycle", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: label ? null : "scripted pick not among curated options", isMock: false } };
  }
  const provider = getProviderBySpec(d.spec, cfg, { purpose: "bench_scenarios", ...(d.id === "deepinfra_think" ? { timeoutMs: 300_000, maxTokens: 16_384 } : {}) });
  const base = scenarioRequest(s);
  const { request, toReal } = d.anon ? anonymize(base) : { request: base, toReal: null };
  const res: DecisionResponse = await provider.decide(request);
  const raw = res.answers.next_action;
  let label = raw?.chosen ?? null;
  let probabilities = raw?.probabilities ?? null;
  if (toReal) {
    label = label ? (toReal.get(label) ?? null) : null;
    probabilities = probabilities ? Object.fromEntries(Object.entries(probabilities).map(([k, v]) => [toReal.get(k) ?? k, v])) : null;
  }
  if (label && !s.options.some((o) => o.label === label)) label = null;
  if (!toReal && !chosenOption(s.options, res)) label = null;
  return { scenarioId: s.id, label, probabilities, meta: res.meta };
}

const answers: Record<string, Answer[]> = {};
const firstPassFallbacks: Record<string, { scenarioId: string; error: string | null }[]> = {};
const byIdAll = new Map(scenarios.map((s) => [s.id, s]));
const t0 = performance.now();
for (const d of DECIDERS) {
  const limit = pLimit(d.concurrency);
  const list = d.subset ? scenarios.filter((s) => d.subset!.includes(s.id)) : scenarios;
  const started = performance.now();
  answers[d.id] = await Promise.all(list.map((s) => limit(() => ask(d, s))));
  const fb = answers[d.id]!.filter((a) => a.meta?.fallbackUsed);
  firstPassFallbacks[d.id] = fb.map((a) => ({ scenarioId: a.scenarioId, error: a.meta?.error ?? null }));
  // Offline benchmark: a fallback is re-asked once, one at a time; both counts are reported.
  for (const a of fb) {
    const again = await ask(d, byIdAll.get(a.scenarioId)!);
    answers[d.id]![answers[d.id]!.indexOf(a)] = again;
  }
  const fb2 = answers[d.id]!.filter((a) => a.meta?.fallbackUsed).length;
  console.log(`[bench:scenarios] ${d.id}: ${list.length} answers in ${((performance.now() - started) / 1000).toFixed(1)} s, ${fb.length} first-pass fallbacks, ${fb2} after one retry`);
}

const byId = new Map(scenarios.map((s) => [s.id, s]));
const valueOf = (s: Scenario, label: string | null) => (label ? (s.answerKey!.values[label]?.mean ?? null) : null);
const regretOf = (s: Scenario, label: string | null) => {
  const v = valueOf(s, label);
  return v === null ? null : s.answerKey!.values[s.answerKey!.best]!.mean - v;
};
const scored = (a: Answer) => a.label !== null && !a.meta?.fallbackUsed;

// event log
for (const [id, list] of Object.entries(answers)) {
  for (const a of list) {
    const s = byId.get(a.scenarioId)!;
    logger.write({
      type: "scenario_result",
      isMock: a.meta?.isMock ?? false,
      scenarioId: s.id,
      familyId: s.familyId,
      provider: id,
      model: a.meta?.model ?? "",
      chosenLabel: a.label,
      bestLabel: s.answerKey!.best,
      top1: a.label === s.answerKey!.best,
      regret: scored(a) ? regretOf(s, a.label) : null,
      meta: a.meta!,
    });
  }
}

// context sensitivity
function contextSensitivity(list: Answer[]) {
  const pick = new Map(list.filter(scored).map((a) => [a.scenarioId, a.label!]));
  const perFamily: { familyId: string; pairs: number; correct: number }[] = [];
  for (const f of set.families) {
    const base = byId.get(f.baseScenarioId);
    if (!base) continue;
    let pairs = 0;
    let correct = 0;
    for (const v of scenarios.filter((x) => x.familyId === f.id && x.id !== base.id)) {
      if (v.answerKey!.ambiguous || v.answerKey!.best === base.answerKey!.best) continue; // key does not say the answer must change
      const cb = pick.get(base.id);
      const cv = pick.get(v.id);
      if (!cb || !cv) continue;
      pairs += 1;
      const vb = valueOf(v, cb);
      const vv = valueOf(v, cv)!;
      const meanV = mean(Object.values(v.answerKey!.values).map((x) => x.mean));
      const ok = cv !== cb && (vb !== null ? vv > vb : vv > meanV);
      if (ok) correct += 1;
    }
    if (pairs > 0) perFamily.push({ familyId: f.id, pairs, correct });
  }
  const fam = perFamily.length ? perFamily.filter((f) => f.correct / f.pairs >= 0.5).length / perFamily.length : null;
  const pairsTotal = perFamily.reduce((s, f) => s + f.pairs, 0);
  return { families_scored: perFamily.length, fraction_families: fam, pairs: pairsTotal, fraction_pairs: pairsTotal ? perFamily.reduce((s, f) => s + f.correct, 0) / pairsTotal : null, perFamily };
}

const summary: Record<string, unknown> = {};
const rows: Record<string, unknown>[] = [];
for (const [id, list] of Object.entries(answers)) {
  const ok = list.filter(scored);
  const unamb = ok.filter((a) => !byId.get(a.scenarioId)!.answerKey!.ambiguous);
  const metas = list.map((a) => a.meta!).filter((m) => !m.fallbackUsed);
  const lat = metas.map((m) => m.latencyMs);
  const regrets = ok.map((a) => regretOf(byId.get(a.scenarioId)!, a.label)!);
  const isNet = metas.some((m) => m.inputTokens > 0);
  summary[id] = {
    models: [...new Set(list.map((a) => a.meta?.model ?? ""))],
    reasoning: id === "deepinfra_think" ? "on" : id === "deepinfra" ? "off" : null,
    n_asked: list.length,
    n_scored: ok.length,
    fallbacks: list.filter((a) => a.meta?.fallbackUsed).length,
    fallbacks_first_pass: firstPassFallbacks[id]?.length ?? 0,
    fallback_errors_first_pass: firstPassFallbacks[id] ?? [],
    unusable_answers: list.filter((a) => a.label === null && !a.meta?.fallbackUsed).length,
    n_unambiguous_scored: unamb.length,
    top1: unamb.length ? round(unamb.filter((a) => a.label === byId.get(a.scenarioId)!.answerKey!.best).length / unamb.length) : null,
    regret: regrets.length ? round(mean(regrets)) : null,
    context_sensitivity: id === "deepinfra_think" ? null : contextSensitivity(list),
    latency_p50_ms: isNet || id === "random" || id === "scripted" ? round(pct(lat, 0.5), 1) : null,
    latency_p95_ms: isNet || id === "random" || id === "scripted" ? round(pct(lat, 0.95), 1) : null,
    latency_note: "round trip (request sent to answer parsed, retries included), from meta.latencyMs",
    cost_per_1k_usd: metas.length ? round((1000 * metas.reduce((s, m) => s + m.costUsd, 0)) / metas.length, 5) : null,
    total_cost_usd: round(metas.reduce((s, m) => s + m.costUsd, 0), 5),
    mean_input_tokens: metas.length ? round(mean(metas.map((m) => m.inputTokens)), 1) : null,
    isMock: list.some((a) => a.meta?.isMock),
  };
  for (const a of list) {
    const s = byId.get(a.scenarioId)!;
    rows.push({ decider: id, scenarioId: s.id, familyId: s.familyId, ambiguous: s.answerKey!.ambiguous, chosen: a.label, best: s.answerKey!.best, top1: a.label === s.answerKey!.best, regret: scored(a) ? round(regretOf(s, a.label)!) : null, latencyMs: round(a.meta?.latencyMs ?? NaN, 1), costUsd: a.meta?.costUsd ?? null, fallbackUsed: a.meta?.fallbackUsed ?? null, model: a.meta?.model ?? null, error: a.meta?.error ?? null });
  }
}
const isMock = Object.values(summary).some((v) => (v as { isMock: boolean }).isMock) || ENGINE_IS_STUB;
const giantModel = (summary.deepinfra as { models: string[] }).models.join(",");
const file = writeResults({
  experiment: "bench_scenarios",
  createdTs: new Date().toISOString(),
  isMock,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: {
    scenarios: "data/scenarios/scenarios.json (bases mined from dev-seed scripted matches; one-flip variants)",
    requestSeed: SCENARIO_REQUEST_SEED,
    requestMode: "offline",
    deciders: DECIDERS.map((d) => ({ id: d.id, spec: d.spec, anonymizedLabels: !!d.anon, subset: d.subset ?? "all" })),
    giant: { model: giantModel, reasoning_main: "off (the giant's fastest configuration; conservative for the speed claim)", reasoning_on_subset: thinkSubset },
    answerKey: { rolloutsPerOption: cfg.answerKey.rollouts, horizonS: cfg.answerKey.horizonS },
    scoring: "top-1 on unambiguous scenarios; regret = best mean - chosen mean on all scenarios; fallbacks counted, not scored; context sensitivity: per family, pairs (base, variant) where the key's best differs and the variant is unambiguous; a pair is correct when the decider changed its pick and the new pick is worth more in the variant than its base pick (or above the variant's mean option value when the base pick is not offered); a family counts when at least half its pairs are correct",
    simplified: "options are a curated 6-8 option subset of the full mask (fixed rule in curateOptions); the scripted baseline is basic_cycle applied to the scenario view",
  },
  rows,
  summary: { n_scenarios: scenarios.length, n_families: set.families.length, n_unambiguous: scenarios.filter((s) => !s.answerKey!.ambiguous).length, wall_s: round((performance.now() - t0) / 1000, 1), deciders: summary },
});
logger.write({ type: "run_end", isMock, status: "ok", durationMs: performance.now() - t0, totalCostUsd: Object.values(summary).reduce((s: number, v) => s + ((v as { total_cost_usd: number }).total_cost_usd ?? 0), 0), error: null });

// results/scenarios.json for the UI and the lab
const picks: Record<string, Record<string, { label: string | null; probabilities?: Record<string, number> } | null>> = {};
for (const s of scenarios) picks[s.id] = {};
for (const [id, list] of Object.entries(answers)) for (const a of list) picks[a.scenarioId]![id] = scored(a) ? { label: a.label, ...(a.probabilities ? { probabilities: a.probabilities } : {}) } : null;
writeJson(
  { experiment: "scenarios", createdTs: new Date().toISOString(), isMock, gitCommit: gitCommit(), simHash: simHash(cfg), note: "REAL: snapshots from the real engine on dev-seed scripted matches; answer keys from rollouts; picks from real provider calls (see bench_scenarios.json). A null pick = fallback or unusable answer.", families: set.families, scenarios, picks },
  "results",
  "scenarios.json",
);
console.log(`[bench:scenarios] -> ${file}`);
for (const [id, v] of Object.entries(summary)) {
  const x = v as Record<string, any>;
  console.log(`  ${id.padEnd(16)} top1 ${x.top1} (n=${x.n_unambiguous_scored}) regret ${x.regret} ctx ${x.context_sensitivity?.fraction_families ?? "-"} p50 ${x.latency_p50_ms} ms p95 ${x.latency_p95_ms} ms $/1k ${x.cost_per_1k_usd} fallbacks ${x.fallbacks} models ${x.models.join(",")}`);
}
