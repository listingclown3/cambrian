/**
 * pnpm nace:scenarios [-- --skip-think] (owner: P3)
 * Ask every decider every scenario with the IDENTICAL request (scenarioRequest in common.ts:
 * the focus robot's observation view rendered by src/search/steer/ask.ts, with the scenario's curated
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
 * Writes results/bench_scenarios.json, results/scenarios.json (UI + lab), data/scenarios/answers.json
 * (every decider's answers with their meta, so scoring can be redone without new calls) and a run log.
 *
 *   --rescore        no provider calls: re-score the saved answers (data/scenarios/answers.json, or
 *                    the first run's rows) against the current answer key
 *   --latency-only   see benchLatency.ts (sequential round-trip latency, one decider at a time)
 * A decider whose first 3 answers are all fallbacks is treated as unreachable and stopped; the
 * reason is recorded instead of filling the file with fallbacks.
 * The random baseline is scored by its exact expectation (uniform over the scored options).
 * Regret is reported with a 95% CI over scenarios, plus paired differences between deciders.
 * Latency here is "measured under load" (a shared laptop); headline latency comes from
 * results/bench_latency.json when it exists.
 */
if (process.argv.includes("--latency-only")) {
  await import("./benchLatency");
  process.exit(0);
}
import "dotenv/config";
import pLimit from "p-limit";
import type { DecisionMeta, DecisionResponse, Scenario } from "../../../src/contracts";
import { chosenOption } from "../../../src/search/steer/ask";
import { getProviderBySpec } from "../../../src/providers/registry";
import { ENGINE_IS_STUB, engine } from "../../../src/world/worlds/rebuilt/engine";
import { loadConfig } from "../../../src/util/config";
import { gitCommit, simHash } from "../../../src/util/provenance";
import { RunLogger, buildManifest, newRunId, writeResults } from "../../../src/util/runLog";
import { PROMPT_VERSION, anonymize, ci95, readJson, writeJson, loadScenarioSet, mean, pct, round, scenarioRequest, scriptedLabelFor, SCENARIO_REQUEST_SEED } from "./common";

const cfg = loadConfig();
const set = loadScenarioSet();
const scenarios = set.scenarios.filter((s) => s.answerKey);
if (scenarios.length !== set.scenarios.length) throw new Error("some scenarios have no answer key: run pnpm nace:answerkey first");
const skipThink = process.argv.includes("--skip-think");
const rescore = process.argv.includes("--rescore");

// ── degeneracy gate (planner, 1:20 PM): checked on the answer key alone, before any scoring ──
// no label best in > 35% of scenarios; >= 30% of flips change the best answer; scripted beats
// random on mean regret. If it fails, nothing is scored: the gate is written and the run stops.
function degeneracyGate() {
  const counts = new Map<string, number>();
  for (const s of scenarios) counts.set(s.answerKey!.best, (counts.get(s.answerKey!.best) ?? 0) + 1);
  const [topLabel, topCount] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  const byIdG = new Map(scenarios.map((s) => [s.id, s]));
  const variants = scenarios.filter((s) => s.flip !== "");
  const changed = variants.filter((v) => {
    const base = byIdG.get(set.families.find((f) => f.id === v.familyId)!.baseScenarioId);
    return base && base.answerKey!.best !== v.answerKey!.best;
  }).length;
  const reg = (s: Scenario, l: string | null) => (l && s.answerKey!.values[l] ? s.answerKey!.values[s.answerKey!.best]!.mean - s.answerKey!.values[l]!.mean : null);
  const scr = scenarios.map((s) => reg(s, scriptedLabelFor(engine.restore(s.snapshot), s.focusRobotId, s.options))).filter((x): x is number => x !== null);
  const rnd = scenarios.map((s) => mean(s.options.map((o) => reg(s, o.label)!)));
  const gaps = scenarios.map((s) => {
    const r = Object.values(s.answerKey!.values).map((v) => v.mean).sort((a, b) => b - a);
    return r[0]! - (r[1] ?? r[0]!);
  });
  const checks = {
    max_best_label_share: { value: round(topCount / scenarios.length), label: topLabel, limit: "<= 0.35", pass: topCount / scenarios.length <= 0.35 },
    flips_changing_best: { value: round(changed / Math.max(1, variants.length)), n_flips: variants.length, limit: ">= 0.30", pass: changed / Math.max(1, variants.length) >= 0.3 },
    scripted_vs_random_regret: { scripted: round(mean(scr)), n_scripted: scr.length, random_expected: round(mean(rnd)), limit: "scripted < random", pass: mean(scr) < mean(rnd) },
  };
  return { pass: Object.values(checks).every((c) => c.pass), checks, distinct_best_labels: counts.size, top_vs_second_gap: { mean: round(mean(gaps)), median: round([...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!) }, n_unambiguous: scenarios.filter((s) => !s.answerKey!.ambiguous).length };
}
const gate = degeneracyGate();
console.log(`[bench:scenarios] degeneracy gate: ${gate.pass ? "PASS" : "FAIL"} ${JSON.stringify(gate)}`);
if (!gate.pass && !process.argv.includes("--ignore-gate")) {
  writeResults({ experiment: "bench_scenarios_gate", createdTs: new Date().toISOString(), isMock: false, gitCommit: gitCommit(), simHash: simHash(cfg), config: { answerKeySimHash: set.simHash, note: "Degeneracy gate failed: nothing was scored." }, rows: [], summary: gate });
  console.log("[bench:scenarios] gate failed: not scoring (results/bench_scenarios_gate.json)");
  process.exit(2);
}
const runId = newRunId("bench_scenarios");
const logger = new RunLogger(runId);
logger.write({ type: "run_start", isMock: false, manifest: buildManifest({ runId, cfg, seeds: { dev: [], eval: [] }, provider: "mixed", model: "mixed", isMock: false }) });

interface Answer {
  scenarioId: string;
  label: string | null;
  probabilities: Record<string, number> | null;
  meta: DecisionMeta | null;
}

let thinkSubset = scenarios.filter((s) => !s.answerKey!.ambiguous).map((s) => s.id).sort().slice(0, 8);

type Decider = { id: string; spec: string | null; subset?: string[]; anon?: boolean; concurrency: number };
const onlyArg = process.argv.indexOf("--deciders") >= 0 ? process.argv[process.argv.indexOf("--deciders") + 1]!.split(",") : null;
const ALL_DECIDERS: Decider[] = [
  { id: "drex", spec: "drex", concurrency: 1 },
  { id: "drex-latest", spec: "drex:drex-latest", concurrency: 1 },
  { id: "drex_anon", spec: "drex", anon: true, concurrency: 1 },
  { id: "deepinfra", spec: "deepinfra", concurrency: 1 },
  ...(skipThink ? [] : [{ id: "deepinfra_think", spec: "deepinfra@think", subset: thinkSubset, concurrency: 4 }]),
  { id: "scripted", spec: null, concurrency: 1 },
  { id: "random", spec: "random", concurrency: 1 },
];
const DECIDERS = onlyArg ? ALL_DECIDERS.filter((d) => onlyArg.includes(d.id)) : ALL_DECIDERS;

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
let firstPassFallbacks: Record<string, { scenarioId: string; error: string | null }[]> = {};
const unreachable: Record<string, string> = {};
const byIdAll = new Map(scenarios.map((s) => [s.id, s]));
const t0 = performance.now();
const SAVED = ["data", "scenarios", "answers.json"] as const;
let answersSource = `fresh calls in this run (prompt version ${PROMPT_VERSION}); prompts carried exactly the options scored here`;
const providerOf = (decider: string) => (decider.startsWith("drex") ? "drex" : decider.startsWith("deepinfra") ? "deepinfra" : decider) as DecisionMeta["provider"];
const savedBefore = readJson(...SAVED);
if (rescore) {
  if (savedBefore) {
    Object.assign(answers, savedBefore.answers);
    firstPassFallbacks = savedBefore.firstPassFallbacks ?? {};
    answersSource = savedBefore.answersSource;
    thinkSubset = savedBefore.thinkSubset ?? thinkSubset;
  } else {
    // Bootstrap from the first run's results (12:33 PM): rows + picks (probabilities).
    const prev = readJson("results", "bench_scenarios.json");
    const prevPicks = readJson("results", "scenarios.json")?.picks ?? {};
    if (!prev) throw new Error("--rescore: no saved answers");
    for (const r of prev.rows as any[]) {
      (answers[r.decider] ??= []).push({
        scenarioId: r.scenarioId,
        label: r.chosen ?? null,
        probabilities: prevPicks[r.scenarioId]?.[r.decider]?.probabilities ?? null,
        meta: { provider: providerOf(r.decider), model: r.model ?? "", latencyMs: r.latencyMs ?? 0, inputTokens: 0, outputTokens: 0, costUsd: r.costUsd ?? 0, fallbackUsed: !!r.fallbackUsed, cached: false, error: r.error ?? null, isMock: false },
      });
    }
    for (const [id, list] of Object.entries(answers)) firstPassFallbacks[id] = list.filter((a) => a.meta?.fallbackUsed).map((a) => ({ scenarioId: a.scenarioId, error: a.meta?.error ?? null }));
    thinkSubset = (answers.deepinfra_think ?? []).map((a) => a.scenarioId);
    answersSource =
      "answers recorded in the first run (12:33 PM, results/bench_scenarios.json at commit 2c3bdc7, old engine), before the climb-exclusion rule: in non-endgame scenarios the prompt also listed one climb option that is not in the scored set (a pick of it is counted in excluded_picks, not scored). No retry pass existed then, so first-pass fallbacks = final fallbacks. Token counts were not saved (mean_input_tokens null). The snapshots the deciders saw are the scenario snapshots; only the answer key is recomputed on the current engine.";
  }
  console.log("[bench:scenarios] re-scoring saved answers (no provider calls)");
} else {
  for (const d of DECIDERS) {
    const limit = pLimit(d.concurrency);
    const list = d.subset ? scenarios.filter((s) => d.subset!.includes(s.id)) : scenarios;
    const started = performance.now();
    // Reachability check: the first 3 answers one at a time; all fallbacks = stop this decider.
    const head: Answer[] = [];
    for (const s of list.slice(0, 3)) head.push(await ask(d, s));
    if (d.spec !== null && head.length > 0 && head.every((a) => a.meta?.fallbackUsed)) {
      unreachable[d.id] = `stopped: first ${head.length} answers were all fallbacks (${head[0]!.meta?.error ?? ""})`.slice(0, 300);
      console.log(`[bench:scenarios] ${d.id}: UNREACHABLE, ${unreachable[d.id]}`);
      continue;
    }
    answers[d.id] = [...head, ...(await Promise.all(list.slice(3).map((s) => limit(() => ask(d, s)))))];
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
}
if (!rescore || !savedBefore) writeJson({ createdTs: new Date().toISOString(), simHash: simHash(cfg), answersSource, thinkSubset, answers, firstPassFallbacks, unreachable }, ...SAVED);

const byId = new Map(scenarios.map((s) => [s.id, s]));
const valueOf = (s: Scenario, label: string | null) => (label ? (s.answerKey!.values[label]?.mean ?? null) : null);
const regretOf = (s: Scenario, label: string | null) => {
  const v = valueOf(s, label);
  return v === null ? null : s.answerKey!.values[s.answerKey!.best]!.mean - v;
};
const inOptions = (a: Answer) => a.label !== null && byId.get(a.scenarioId)!.options.some((o) => o.label === a.label);
const scored = (a: Answer) => inOptions(a) && !a.meta?.fallbackUsed;
// secondary key (to match end), when present
const secondary: Record<string, { values: Record<string, { mean: number }>; best: string }> = readJson("data", "scenarios", "answerkey_match_end.json")?.keys ?? {};
const regret2Of = (id: string, label: string | null) => {
  const k = secondary[id];
  const v = label ? k?.values[label]?.mean : undefined;
  return k && v !== undefined ? k.values[k.best]!.mean - v : null;
};

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
  const regrets2 = ok.map((a) => regret2Of(a.scenarioId, a.label)).filter((x): x is number => x !== null);
  summary[id] = {
    models: [...new Set(list.map((a) => a.meta?.model ?? ""))],
    reasoning: id === "deepinfra_think" ? "on" : id === "deepinfra" ? "off" : null,
    n_asked: list.length,
    n_scored: ok.length,
    fallbacks: list.filter((a) => a.meta?.fallbackUsed).length,
    fallbacks_first_pass: firstPassFallbacks[id]?.length ?? 0,
    fallback_errors_first_pass: firstPassFallbacks[id] ?? [],
    unusable_answers: list.filter((a) => a.label === null && !a.meta?.fallbackUsed).length,
    excluded_picks: list.filter((a) => a.label !== null && !inOptions(a) && !a.meta?.fallbackUsed).length,
    regret_ci95: regrets.length ? round(ci95(regrets)) : null,
    n_regret: regrets.length,
    regret_match_end_key: regrets2.length ? round(mean(regrets2)) : null,
    regret_match_end_key_ci95: regrets2.length ? round(ci95(regrets2)) : null,
    n_regret_match_end_key: regrets2.length,
    n_unambiguous_scored: unamb.length,
    top1: unamb.length ? round(unamb.filter((a) => a.label === byId.get(a.scenarioId)!.answerKey!.best).length / unamb.length) : null,
    regret: regrets.length ? round(mean(regrets)) : null,
    context_sensitivity: id === "deepinfra_think" ? null : contextSensitivity(list),
    latency_p50_ms: round(pct(lat, 0.5), 1),
    latency_p95_ms: round(pct(lat, 0.95), 1),
    latency_note: "round trip (request sent to answer parsed, retries included), from meta.latencyMs; MEASURED UNDER LOAD (shared laptop, other agents running)",
    cost_per_1k_usd: metas.length ? round((1000 * metas.reduce((s, m) => s + m.costUsd, 0)) / metas.length, 5) : null,
    total_cost_usd: round(metas.reduce((s, m) => s + m.costUsd, 0), 5),
    mean_input_tokens: metas.length && metas.some((m) => m.inputTokens > 0) ? round(mean(metas.map((m) => m.inputTokens)), 1) : null,
    isMock: list.some((a) => a.meta?.isMock),
  };
  for (const a of list) {
    const s = byId.get(a.scenarioId)!;
    rows.push({ decider: id, promptVersion: rescore ? null : PROMPT_VERSION, scenarioId: s.id, familyId: s.familyId, ambiguous: s.answerKey!.ambiguous, chosen: a.label, best: s.answerKey!.best, top1: a.label === s.answerKey!.best, regret: scored(a) ? round(regretOf(s, a.label)!) : null, latencyMs: round(a.meta?.latencyMs ?? NaN, 1), costUsd: a.meta?.costUsd ?? null, fallbackUsed: a.meta?.fallbackUsed ?? null, model: a.meta?.model ?? null, error: a.meta?.error ?? null });
  }
}
// Random baseline: exact expectation of a uniform pick over the scored options (no sampling).
const expRegret = (s: Scenario) => mean(s.options.map((o) => regretOf(s, o.label)!));
if (summary.random) {
  const unambS = scenarios.filter((s) => !s.answerKey!.ambiguous);
  const r = scenarios.map(expRegret);
  const exp2 = scenarios.map((s) => (secondary[s.id] ? mean(s.options.map((o) => regret2Of(s.id, o.label) ?? NaN).filter(Number.isFinite)) : NaN)).filter(Number.isFinite);
  Object.assign(summary.random as object, {
    scoring: "exact expectation of a uniform pick (the sampled picks are kept in rows)",
    n_unambiguous_scored: unambS.length,
    n_scored: scenarios.length,
    n_regret: scenarios.length,
    top1: round(mean(unambS.map((s) => 1 / s.options.length))),
    regret: round(mean(r)),
    regret_ci95: round(ci95(r)),
    regret_match_end_key: exp2.length ? round(mean(exp2)) : null,
    regret_match_end_key_ci95: exp2.length ? round(ci95(exp2)) : null,
  });
}
// Paired regret differences (same scenarios, both deciders scored).
function pairedRegret(a: string, b: string) {
  const ra = new Map((answers[a] ?? []).filter(scored).map((x) => [x.scenarioId, regretOf(byId.get(x.scenarioId)!, x.label)!]));
  const rb = b === "random" ? new Map(scenarios.map((s) => [s.id, expRegret(s)])) : new Map((answers[b] ?? []).filter(scored).map((x) => [x.scenarioId, regretOf(byId.get(x.scenarioId)!, x.label)!]));
  const d = [...ra.keys()].filter((k) => rb.has(k)).map((k) => ra.get(k)! - rb.get(k)!);
  return d.length ? { n: d.length, mean_diff: round(mean(d)), ci95: round(ci95(d)) } : null;
}
const paired = {
  drex_minus_giant: pairedRegret("drex", "deepinfra"),
  drex_minus_scripted: pairedRegret("drex", "scripted"),
  drex_minus_random: pairedRegret("drex", "random"),
  giant_minus_scripted: pairedRegret("deepinfra", "scripted"),
  giant_minus_random: pairedRegret("deepinfra", "random"),
  scripted_minus_random: pairedRegret("scripted", "random"),
  drex_latest_minus_giant: pairedRegret("drex-latest", "deepinfra"),
  drex_anon_minus_drex: pairedRegret("drex_anon", "drex"),
};
const isMock = Object.values(summary).some((v) => (v as { isMock: boolean }).isMock) || ENGINE_IS_STUB;
const giantModel = (summary.deepinfra as { models?: string[] } | undefined)?.models?.join(",") ?? null;
const file = writeResults({
  experiment: "bench_scenarios",
  createdTs: new Date().toISOString(),
  isMock,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: {
    scenarios: "data/scenarios/scenarios.json (bases mined from dev-seed scripted matches; one-flip variants)",
    requestSeed: SCENARIO_REQUEST_SEED,
    promptVersion: rescore ? "as recorded with the saved answers (see answersSource)" : PROMPT_VERSION,
    requestMode: "offline",
    deciders: DECIDERS.map((d) => ({ id: d.id, spec: d.spec, anonymizedLabels: !!d.anon, subset: d.subset ?? "all" })),
    giant: { model: giantModel, reasoning_main: "off (the giant's fastest configuration; conservative for the speed claim)", reasoning_on_subset: thinkSubset },
    answerKey: { primary: "results/answerkey.json (see its config for rollouts and horizon)", secondary: "results/answerkey_match_end.json, reported as regret_match_end_key", rule: "climb options excluded before the end game (fixed rule, isExcludedOption)", simHash: set.simHash },
    answersSource,
    unreachable,
    scoring: "top-1 on unambiguous scenarios; regret = best mean - chosen mean on all scenarios; fallbacks counted, not scored; context sensitivity: per family, pairs (base, variant) where the key's best differs and the variant is unambiguous; a pair is correct when the decider changed its pick and the new pick is worth more in the variant than its base pick (or above the variant's mean option value when the base pick is not offered); a family counts when at least half its pairs are correct",
    simplified: "options are a curated 6-8 option subset of the full mask (fixed rule in curateOptions); the scripted baseline is basic_cycle applied to the scenario view",
  },
  rows,
  summary: { degeneracy_gate: gate, rescored: rescore, paired_regret: paired, n_scenarios: scenarios.length, n_families: set.families.length, n_unambiguous: scenarios.filter((s) => !s.answerKey!.ambiguous).length, wall_s: round((performance.now() - t0) / 1000, 1), deciders: summary },
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
