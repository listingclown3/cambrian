#!/usr/bin/env node
/**
 * pnpm deck: write results/deck_numbers.txt, one line per blank in the pitch deck, in deck order.
 *
 * Every value comes from a results file written by a real run. A blank whose experiment has not
 * run is written as NOT RUN (delete that line from the deck). Nothing is estimated, and a value
 * from mock data is never used. Run `pnpm ledger:merge && pnpm usage && pnpm headline` first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const load = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const headlineFile = load("results/headline.json");
const h = headlineFile?.summary ?? {};
const NOT_RUN = "NOT RUN";
const has = (...keys) => keys.every((k) => typeof h[k] === "number" && Number.isFinite(h[k]));
const fix = (v, digits) => Number(v.toFixed(digits)).toString();
const ms = (v) => (v < 10 ? fix(v, 1) : String(Math.round(v)));
const ratio = (v) => (v >= 10 ? String(Math.round(v)) : fix(v, 1));
const usd = (v) => (v === 0 ? "$0" : `$${Number(v.toPrecision(2))}`);
const pct = (v) => `${Math.round(v * 100)}%`;
const signed = (v) => `${v >= 0 ? "+" : ""}${fix(v, 1)}`;
const int = (v) => Math.round(v).toLocaleString("en-US");

const lines = [];
const section = (name) => lines.push("", `[${name}]`);
/** One deck blank: label | value | where it came from. */
const blank = (label, value, source) => lines.push(`${label} | ${value ?? NOT_RUN} | ${value == null ? "-" : source}`);
const when = (keys, make) => (has(...keys) ? make() : null);

lines.push(`deck numbers, generated ${new Date().toISOString()}`);
lines.push(`source: results/headline.json (git ${headlineFile?.gitCommit ?? "?"}, simHash ${headlineFile?.simHash ?? "?"}), all_real: ${h.all_real ?? "not set"}`);
lines.push("format: deck blank | value | source key(s). NOT RUN means the experiment did not run: delete that line from the deck.");

section("cover");
lines.push("none");

section("results");
// Main speed stat: batched at match size (one alliance = 3 questions in one call).
const b3 = when(["batch3_ms_per_decision_drex", "batch3_ms_per_decision_giant"], () => ({ d: h.batch3_ms_per_decision_drex, g: h.batch3_ms_per_decision_giant }));
blank(
  "MAIN SPEED STAT: per decision, one alliance batched (3 questions per call)",
  b3 ? `Drex ${ms(b3.d)} ms vs giant ${ms(b3.g)} ms (${ratio(b3.g / b3.d)}x faster)` : null,
  "batch3_ms_per_decision_drex, batch3_ms_per_decision_giant (results/bench_batch.json)",
);
blank("single-question latency ratio (x faster)", when(["latency_ratio_deepinfra_over_drex"], () => `${ratio(h.latency_ratio_deepinfra_over_drex)}x`), "latency_ratio_deepinfra_over_drex");
blank("drex p50 ms", when(["drex_p50_ms"], () => `${ms(h.drex_p50_ms)} ms`), "drex_p50_ms");
blank("giant p50 ms", when(["deepinfra_p50_ms"], () => `${ms(h.deepinfra_p50_ms)} ms`), "deepinfra_p50_ms");
blank(
  "cost ratio (x cheaper)",
  when(["drex_cost_per_1k_usd", "deepinfra_cost_per_1k_usd"], () => (h.drex_cost_per_1k_usd > 0 ? `${ratio(h.deepinfra_cost_per_1k_usd / h.drex_cost_per_1k_usd)}x` : null)),
  "deepinfra_cost_per_1k_usd / drex_cost_per_1k_usd",
);
blank("drex $ per 1k decisions", when(["drex_cost_per_1k_usd"], () => usd(h.drex_cost_per_1k_usd)), "drex_cost_per_1k_usd");
blank("giant $ per 1k decisions", when(["deepinfra_cost_per_1k_usd"], () => usd(h.deepinfra_cost_per_1k_usd)), "deepinfra_cost_per_1k_usd");
blank("top-1 drex vs giant", when(["top1_drex", "top1_deepinfra"], () => `${pct(h.top1_drex)} vs ${pct(h.top1_deepinfra)}`), "top1_drex, top1_deepinfra");
blank("n scenarios", when(["n_scenarios"], () => int(h.n_scenarios)), "n_scenarios");
blank("n families", when(["n_families"], () => int(h.n_families)), "n_families");
blank(
  "sim matches per hour drex vs giant",
  when(["sim_matches_per_hour_drex", "sim_matches_per_hour_deepinfra"], () => `${int(h.sim_matches_per_hour_drex)} vs ${int(h.sim_matches_per_hour_deepinfra)}`),
  "sim_matches_per_hour_drex, sim_matches_per_hour_deepinfra",
);
blank(
  "real-time sim margin drex vs giant",
  when(["live_margin_drex_realtime", "live_margin_deepinfra_realtime"], () => `${signed(h.live_margin_drex_realtime)} vs ${signed(h.live_margin_deepinfra_realtime)}${has("n_live_seeds") ? ` (n = ${int(h.n_live_seeds)} paired seeds)` : ""}`),
  "live_margin_drex_realtime, live_margin_deepinfra_realtime, n_live_seeds",
);
blank("rollout savings %", when(["rollout_savings_pct_drex_vs_uniform"], () => `${Math.round(h.rollout_savings_pct_drex_vs_uniform)}%`), "rollout_savings_pct_drex_vs_uniform");

section("batch table: ms per decision when one call answers N questions about one state");
lines.push("sizes 1 and 3 are match sizes (one robot, one alliance); 8 and 32 are stress sizes; giant = reasoning off");
const batchFile = load("results/bench_batch.json");
for (const n of [1, 3, 8, 32]) {
  const d = h[`batch${n}_ms_per_decision_drex`];
  const g = h[`batch${n}_ms_per_decision_giant`];
  const range = batchFile?.summary?.[`batch${n}_ms_per_decision_giant_range`];
  const both = typeof d === "number" && typeof g === "number";
  blank(
    `batch ${n}`,
    both ? `Drex ${ms(d)} ms vs giant ${ms(g)} ms (${ratio(g / d)}x)${Array.isArray(range) ? `; giant range across runs ${ms(range[0])} to ${ms(range[1])} ms` : ""}` : typeof d === "number" ? `Drex ${ms(d)} ms; giant NOT RUN` : typeof g === "number" ? `Drex NOT RUN; giant ${ms(g)} ms` : null,
    `batch${n}_ms_per_decision_drex, batch${n}_ms_per_decision_giant`,
  );
}
if (batchFile && !Array.isArray(batchFile.summary?.batch8_ms_per_decision_giant_range)) lines.push("NOTE: the giant's batch 8 time varied a lot between runs (491 ms and 1362 ms were both observed); quote it as a range.");

section("scenario quality: mean regret against the end-of-match answer key (lower is better)");
const bsFile = load("results/bench_scenarios.json");
const dec = bsFile && !bsFile.isMock ? (bsFile.summary?.deciders ?? {}) : {};
const reg = (id) => {
  const x = dec[id];
  if (!x || typeof x.regret !== "number") return null;
  const ci = x.regret_ci95 ?? x.regretCi95 ?? x.regret_ci;
  const n = x.n_scored ?? x.n_regret ?? x.n;
  return `${fix(x.regret, 1)}${typeof ci === "number" ? ` ± ${fix(ci, 1)}` : ""}${typeof n === "number" ? ` (n ${n})` : ""}`;
};
blank(
  "regret: Drex vs giant vs scripted vs random",
  reg("drex") && reg("deepinfra") ? `Drex ${reg("drex")}; giant ${reg("deepinfra")}; scripted ${reg("scripted") ?? NOT_RUN}; random ${reg("random") ?? NOT_RUN}` : null,
  "results/bench_scenarios.json summary.deciders[*].regret",
);
const pairedAll = bsFile && !bsFile.isMock ? (bsFile.summary?.paired_regret ?? {}) : {};
const pairedLine = (key) => {
  const p = pairedAll[key];
  return p && typeof p.mean_diff === "number" ? `${fix(p.mean_diff, 1)} ± ${fix(p.ci95 ?? 0, 1)} (n ${p.n ?? "?"})` : null;
};
blank("paired difference, Drex minus giant (negative = Drex better)", pairedLine("drex_minus_giant"), "results/bench_scenarios.json summary.paired_regret.drex_minus_giant");
blank("paired difference, Drex minus scripted", pairedLine("drex_minus_scripted"), "results/bench_scenarios.json summary.paired_regret.drex_minus_scripted");
if (bsFile) lines.push(`prompt version: ${bsFile.summary?.promptVersion ?? bsFile.config?.promptVersion ?? "not recorded"}; sim hash ${bsFile.simHash}; answer key sim hash ${load("results/answerkey.json")?.simHash ?? "?"}`);

section("quirk check");
const quirks = load("results/quirks.json");
const post = quirks && !quirks.isMock ? quirks.rows?.find((r) => r.id === "tower_post_up" || r.source === "tower_post_up") : null;
blank(
  "tower post-up",
  post && post.legality
    ? (() => {
        const g210 = (post.rules ?? []).find((r) => r.id === "G210");
        return `tested the tower post-up; Drex flagged it ${post.legality}: G210 violation probability ${g210 ? fix(g210.pViolation ?? NaN, 2) : "?"}${g210?.page ? ` (manual p.${g210.page})` : ""}, and probability ${fix(post.reliesOnOpponentFouls ?? NaN, 2)} that its value depends on inducing opponent fouls; in ${post.value?.n ?? "?"} matches it drew ${post.value?.g420FoulsOnOpponents ?? "?"} G420 fouls and added ${fix(post.value?.marginDiff ?? NaN, 1)} points`;
      })()
    : null,
  "results/quirks.json row tower_post_up",
);
if (quirks?.summary) lines.push(`all playbook entries: ${quirks.summary.LEGAL ?? 0} LEGAL, ${quirks.summary.RISKY ?? 0} RISKY, ${quirks.summary.ILLEGAL ?? 0} ILLEGAL; ${quirks.summary.simulated ?? 0} simulated`);

section("builtwith");
blank("drex questions", when(["usage_drex_questions"], () => int(h.usage_drex_questions)), "usage_drex_questions");
blank("intern sessions", when(["usage_intern_sessions"], () => int(h.usage_intern_sessions)), "usage_intern_sessions");
blank("ndi docs", when(["usage_ndi_docs"], () => int(h.usage_ndi_docs)), "usage_ndi_docs");
blank("deepinfra calls", when(["usage_deepinfra_calls"], () => int(h.usage_deepinfra_calls)), "usage_deepinfra_calls");
blank("keenable pages", when(["keenable_pages"], () => int(h.keenable_pages)), "keenable_pages");

section("plus");
// Rule judge. The wording follows who reviewed the labels: it is "accuracy vs human-reviewed
// labels" ONLY when the results file says a person verified them.
for (const [name, file] of [["drex-v2.0", "results/rule_judge.json"], ["drex-latest", "results/rule_judge_drex-latest.json"]]) {
  const r = load(file);
  const s = r?.summary;
  if (!r || r.isMock || !s || typeof s.agreeWithDraftLabels !== "number") {
    blank(`rule judge (${name})`, null, file);
    continue;
  }
  const metric = s.labels_human_verified === true ? "accuracy vs human-reviewed labels" : (s.metricName ?? "agreement with AI-drafted labels (not yet human-verified)");
  blank(`rule judge (${name}): ${metric}`, `${s.agreeWithDraftLabels}/${s.incidents} (${fix(s.agreementPct, 1)}%)`, `${file} summary`);
}
if (!load("results/rule_judge.json")?.summary?.labels_human_verified) lines.push("NOTE: the rule-judge labels are NOT marked human-verified, so the deck must not call this accuracy vs human-reviewed labels.");

const scouting = load("results/ingest_scouting.json");
const ss = scouting?.summary;
blank(
  "NDI scouting extraction",
  scouting && !scouting.isMock && ss && typeof ss.correct === "number"
    ? `${ss.correct} of ${ss.correct + ss.wrong + ss.missed} stated fields recovered, ${ss.wrong} wrong, on ${ss.sheets} fabricated sheets (${fix(ss.accuracyPct, 1)}%)`
    : null,
  "results/ingest_scouting.json summary",
);

writeFileSync("results/deck_numbers.txt", lines.join("\n") + "\n");
const notRun = lines.filter((l) => l.includes(`| ${NOT_RUN} |`)).length;
console.log(lines.join("\n"));
console.log(`\nwrote results/deck_numbers.txt (${notRun} blank(s) NOT RUN)`);
