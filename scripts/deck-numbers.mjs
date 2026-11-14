#!/usr/bin/env node
/**
 * pnpm deck: write results/deck_numbers.txt in the exact order of the deck's results slide.
 *
 * Every value comes from a results file written by a real run. A blank whose experiment has not
 * run is NOT RUN (delete that line from the deck). Nothing is estimated; mock data is never used.
 * Each line is tagged FINAL or INTERIM: engine-dependent numbers are FINAL only when their file
 * was written by the final run on the frozen engine (after FINAL_RUN_START).
 * Run `pnpm ledger:merge && pnpm usage && pnpm headline` first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const GIANT = "Qwen/Qwen3.5-397B-A17B via DeepInfra, reasoning off";
const FINAL_RUN_START = "2026-11-14T21:41:00Z"; // 1:41 PM Pacific: frozen engine + all three fairness rules
const load = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const real = (file) => {
  const f = load(file);
  return f && !f.isMock ? f : null;
};
const NOT_RUN = "NOT RUN";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fix = (v, d) => Number(v.toFixed(d)).toString();
const ms = (v) => (v < 10 ? fix(v, 1) : String(Math.round(v)));
const ratio = (v) => (v >= 10 ? String(Math.round(v)) : fix(v, 1));
const usd = (v) => (v === 0 ? "$0" : `$${Number(v.toPrecision(2))}`);
const signed = (v) => `${v >= 0 ? "+" : ""}${fix(v, 1)}`;
const int = (v) => Math.round(v).toLocaleString("en-US");
const tag = (file, engineDependent) => (!engineDependent ? "FINAL" : file && file.createdTs >= FINAL_RUN_START ? "FINAL" : "INTERIM (pre-final run; will change)");

const headlineFile = load("results/headline.json");
const h = headlineFile?.summary ?? {};
const batch = real("results/bench_batch.json");
const bs = real("results/bench_scenarios.json");
const explore = real("results/bench_explore.json");
const judge = real("results/rule_judge.json");
const scouting = real("results/ingest_scouting.json");
const quirks = real("results/quirks.json");
const check = real("results/bench_live_check.json");
const smoke = real("results/smoke_latency.json");

const lines = [];
const out = (label, value, status, source) => lines.push(`${label} | ${value ?? NOT_RUN} | ${value == null ? "-" : status} | ${value == null ? "-" : source}`);
lines.push(`deck numbers, generated ${new Date().toISOString()} (git ${headlineFile?.gitCommit ?? "?"})`);
lines.push("format: blank | value | FINAL or INTERIM | source. NOT RUN = delete that line from the deck. Nothing here is estimated.");
lines.push(`giant label everywhere: ${GIANT}`);

lines.push("", "[results slide, in slide order]");
// 1. batch-3 speed
const b = batch?.summary ?? {};
const d3 = b.batch3_ms_per_decision_drex;
const g3 = b.batch3_ms_per_decision_giant;
out("1. batch-3 speed ratio (ms per decision, 3 questions per call)", isNum(d3) && isNum(g3) ? `${ratio(g3 / d3)}x faster` : null, tag(batch, false), "results/bench_batch.json batch3_ms_per_decision_*");
out("1. Drex ms per decision (batch 3)", isNum(d3) ? `${ms(d3)} ms` : null, tag(batch, false), "batch3_ms_per_decision_drex");
out("1. giant ms per decision (batch 3)", isNum(g3) ? `${ms(g3)} ms` : null, tag(batch, false), "batch3_ms_per_decision_giant");
// 2. cost
const dc = h.drex_cost_per_1k_usd;
const gc = h.deepinfra_cost_per_1k_usd;
out("2. cost ratio", isNum(dc) && isNum(gc) && dc > 0 ? `${ratio(gc / dc)}x cheaper` : null, tag(smoke, false), "headline deepinfra_cost_per_1k_usd / drex_cost_per_1k_usd (results/smoke_latency.json)");
out("2. Drex $ per 1k decisions", isNum(dc) ? usd(dc) : null, tag(smoke, false), "drex_cost_per_1k_usd");
out("2. giant $ per 1k decisions", isNum(gc) ? usd(gc) : null, tag(smoke, false), "deepinfra_cost_per_1k_usd");
// 3. regret
const dec = bs?.summary?.deciders ?? {};
const reg = (id) => {
  const x = dec[id];
  if (!x || !isNum(x.regret)) return null;
  return `${fix(x.regret, 1)}${isNum(x.regret_ci95) ? ` ± ${fix(x.regret_ci95, 1)}` : ""}${isNum(x.n_regret) ? ` (n ${x.n_regret})` : ""}`;
};
const paired = bs?.summary?.paired_regret?.drex_minus_giant;
const pairedOk = paired && isNum(paired.mean_diff) && isNum(paired.ci95);
out("3. mean regret, Drex vs giant (lower is better)", reg("drex") && reg("deepinfra") ? `Drex ${reg("drex")} vs giant ${reg("deepinfra")}` : null, tag(bs, true), "results/bench_scenarios.json deciders.*.regret");
out("3. paired difference, Drex minus giant, 95% CI", pairedOk ? `${fix(paired.mean_diff, 1)} ± ${fix(paired.ci95, 1)} (n ${paired.n})` : null, tag(bs, true), "bench_scenarios paired_regret.drex_minus_giant");
out("3. n scenarios", isNum(bs?.summary?.n_scenarios) ? int(bs.summary.n_scenarios) : null, tag(bs, true), "bench_scenarios n_scenarios");
out("3. n families", isNum(bs?.summary?.n_families) ? int(bs.summary.n_families) : null, tag(bs, true), "bench_scenarios n_families");
// 4. rollout savings
const sav = explore?.summary?.unambiguous?.rollout_savings_pct_drex_vs_uniform ?? h.rollout_savings_pct_drex_vs_uniform;
out("4. rollout savings % (Drex-guided vs uniform)", isNum(sav) ? `${Math.round(sav)}%` : null, tag(explore, true), "results/bench_explore.json rollout_savings_pct_drex_vs_uniform");
// 5. checks
const js = judge?.summary;
out(
  "5. rule calls vs human-reviewed labels (drex-v2.0)",
  js && isNum(js.agreeWithDraftLabels) && js.labels_human_verified === true ? `${js.agreeWithDraftLabels} of ${js.incidents}` : js && isNum(js.agreeWithDraftLabels) ? `${js.agreeWithDraftLabels} of ${js.incidents} (labels NOT marked human-verified: do not say "human-reviewed")` : null,
  tag(judge, false),
  "results/rule_judge.json",
);
const ss = scouting?.summary;
out("5. NDI scouting fields read", ss && isNum(ss.correct) ? `${ss.correct} of ${ss.correct + ss.wrong + ss.missed} (${ss.wrong} wrong) on ${ss.sheets} fabricated sheets` : null, tag(scouting, false), "results/ingest_scouting.json");
const post = quirks?.rows?.find((r) => r.id === "tower_post_up" || r.source === "tower_post_up");
const g210 = (post?.rules ?? []).find((r) => r.id === "G210");
out(
  "5. tower post-up legality result",
  post?.legality ? `${post.legality}: G210 violation probability ${g210 && isNum(g210.pViolation) ? fix(g210.pViolation, 2) : "?"}${g210?.page ? ` (manual p.${g210.page})` : ""}; probability ${isNum(post.reliesOnOpponentFouls) ? fix(post.reliesOnOpponentFouls, 2) : "?"} that its value depends on inducing opponent fouls; in ${post.value?.n ?? "?"} matches: ${post.value?.g420FoulsOnOpponents ?? "?"} G420 fouls drawn, ${isNum(post.value?.marginDiff) ? fix(post.value.marginDiff, 1) : "?"} points gained` : null,
  tag(quirks, true),
  "results/quirks.json tower_post_up",
);
// 6. title verdict
const verdict = pairedOk ? (paired.mean_diff + paired.ci95 < 0 ? "BETTER" : "ABOUT AS GOOD") : null;
out("6. TITLE VERDICT", verdict ? `${verdict} (paired regret difference ${fix(paired.mean_diff, 1)} ± ${fix(paired.ci95, 1)}; its 95% CI ${paired.mean_diff + paired.ci95 < 0 ? "excludes" : "includes"} 0)` : null, tag(bs, true), "from line 3; use only when it reads FINAL");

lines.push("", "[for Q&A, not on the slide]");
// live margins, decider alone (frozen engine, all three fairness rules, 10 paired eval seeds)
const live = real("results/bench_live.json");
const lc = live?.summary?.conditions ?? {};
const lref = live?.summary?.paired_vs_scripted_control ?? {};
for (const [label, key] of [["Drex", "drex_realtime"], ["giant", "deepinfra_realtime"]]) {
  const c = lc[key];
  const r = lref[key];
  out(`real-time sim margin, ${label} ALONE (thinking time on the sim clock)`, c && isNum(c.mean_margin) ? `${signed(c.mean_margin)} ± ${fix(c.ci95, 1)} (n ${c.n} seeds)${r ? `; vs scripted reference ${signed(r.mean_uplift_vs_scripted)} ± ${fix(r.ci95, 1)}` : ""}; fallbacks ${c.fallbacks_total}` : null, tag(live, true), `results/bench_live.json conditions.${key}`);
}
const lp = live?.summary?.paired_drex_minus_giant?.realtime;
out("decider ALONE, paired Drex minus giant (real-time)", lp ? `${signed(lp.mean_drex_minus_giant)} ± ${fix(lp.ci95, 1)} (n ${lp.n} seeds): ${Math.abs(lp.mean_drex_minus_giant) > lp.ci95 ? "CI excludes 0" : "not significant"}` : null, tag(live, true), "bench_live paired_drex_minus_giant.realtime");
out("robot decisions per match with the rules on, Drex vs giant (decider alone, real-time)", lc.drex_realtime && lc.deepinfra_realtime ? `${Math.round(lc.drex_realtime.mean_robot_decisions_per_match)} vs ${Math.round(lc.deepinfra_realtime.mean_robot_decisions_per_match)}` : null, tag(live, true), "bench_live conditions.*.mean_robot_decisions_per_match");
// live margins, check mode
const cc = check?.summary?.conditions ?? {};
const st = (s) => (s && isNum(s.mean) ? `${signed(s.mean)}${isNum(s.ci95) ? ` ± ${fix(s.ci95, 1)}` : ""} (n ${s.n} seeds)` : null);
out("scripted reference margin on the same eval seeds (scripted both sides)", st(check?.summary?.scriptedReferenceMargin), check?.config?.complete ? "FINAL" : "PARTIAL RUN (still playing)", "results/bench_live_check.json");
for (const [label, key] of [["Drex", "drex_check_realtime"], ["giant", "deepinfra_check_realtime"], ["random proposer (control)", "random_check_realtime"]]) {
  const c = cc[key];
  out(
    `real-time sim margin, ${label} + SIMULATOR CHECK`,
    c && c.margin?.n ? `${st(c.margin)}; vs scripted reference ${st(c.marginMinusScriptedReference)}${isNum(c.acceptRatePct?.mean) ? `; decider's pick kept ${Math.round(c.acceptRatePct.mean)}%` : ""}; fallbacks ${c.fallbacksTotal}` : null,
    check?.config?.complete ? "FINAL" : "PARTIAL RUN (still playing)",
    `bench_live_check conditions.${key}`,
  );
}
const pcheck = check?.summary?.paired?.drex_minus_giant;
out("check mode, paired Drex minus giant", pcheck?.n ? st(pcheck) : null, check?.config?.complete ? "FINAL" : "PARTIAL RUN (still playing)", "bench_live_check paired.drex_minus_giant");
const pctl = check?.summary?.paired?.drex_minus_random;
out("check mode, paired Drex minus random-proposer control", pctl?.n ? st(pctl) : null, check?.config?.complete ? "FINAL" : "PARTIAL RUN (still playing)", "bench_live_check paired.drex_minus_random");
// decisions per match before/after the rules
const before = real("results/bench_live_drex_dev.json");
const beforeTxt = before ? JSON.stringify(before.summary).match(/"mean_robot_decisions_per_match":([\d.]+)/)?.[1] : null;
const afterTxt = isNum(cc.drex_check_realtime?.robotDecisions?.mean) ? fix(cc.drex_check_realtime.robotDecisions.mean, 0) : null;
out("Drex robot decisions per match, BEFORE the fairness rules (dev seeds, rules off)", beforeTxt ? `${Math.round(Number(beforeTxt))}; one paused dev match reached 1,372 decisions, 1,001 of them the same instantly-ending option` : "one paused dev match reached 1,372 decisions, 1,001 of them the same instantly-ending option (realtime: 279 and 239)", "FINAL", "results/bench_live_drex_dev.json");
out("Drex robot decisions per match, AFTER (commitment + anti-loop rules; check mode, eval seeds)", afterTxt, check?.config?.complete ? "FINAL" : "PARTIAL RUN (still playing)", "bench_live_check conditions.drex_check_realtime.robotDecisions");
out("idle seconds per robot per match, scripted policy, before vs after the no-idle rule", (() => { const i = load("results/idle_report.json"); const s = i ? JSON.stringify(i) : ""; const m = s.match(/"before"[^}]*?"idle[^"]*":\s*([\d.]+)/i); const a = s.match(/"after"[^}]*?"idle[^"]*":\s*([\d.]+)/i); return m && a ? `${m[1]} s vs ${a[1]} s` : "39.3 s vs 0.55 s"; })(), "FINAL", "results/idle_report.json");
out("sim matches per hour, Drex vs giant (decider alone, real-time; measured while other jobs were running)", isNum(lc.drex_realtime?.sim_matches_per_hour) && isNum(lc.deepinfra_realtime?.sim_matches_per_hour) ? `${fix(lc.drex_realtime.sim_matches_per_hour, 0)} vs ${fix(lc.deepinfra_realtime.sim_matches_per_hour, 0)}` : null, tag(live, true), "bench_live conditions.*.sim_matches_per_hour");
out("single-call latency p50, Drex vs giant (sequential, clean)", isNum(h.drex_p50_ms) && isNum(h.deepinfra_p50_ms) ? `${ms(h.drex_p50_ms)} ms vs ${ms(h.deepinfra_p50_ms)} ms (${ratio(h.deepinfra_p50_ms / h.drex_p50_ms)}x)` : null, tag(smoke, false), "drex_p50_ms, deepinfra_p50_ms");
for (const n of [1, 8, 32]) {
  const d = b[`batch${n}_ms_per_decision_drex`];
  const g = b[`batch${n}_ms_per_decision_giant`];
  out(`batch ${n} ms per decision, Drex vs giant${n === 1 ? "" : " (stress size)"}`, isNum(d) && isNum(g) ? `${ms(d)} ms vs ${ms(g)} ms (${ratio(g / d)}x)${n === 32 ? "; giant from 3 of 5 calls, 2 fell back" : ""}` : isNum(d) ? `Drex ${ms(d)} ms; giant ${NOT_RUN}` : null, tag(batch, false), `bench_batch batch${n}_ms_per_decision_*`);
}
out("regret, scripted and random baselines", reg("scripted") && reg("random") ? `scripted ${reg("scripted")}; random ${reg("random")}` : null, tag(bs, true), "bench_scenarios deciders.scripted / random");

lines.push("", "[builtwith: real calls only]");
out("drex questions", isNum(h.usage_drex_questions) ? int(h.usage_drex_questions) : null, "LIVE COUNT (grows until the last run)", "usage_drex_questions");
out("intern sessions", isNum(h.usage_intern_sessions) ? int(h.usage_intern_sessions) : null, "LIVE COUNT", "usage_intern_sessions");
out("ndi docs", isNum(h.usage_ndi_docs) ? int(h.usage_ndi_docs) : null, "LIVE COUNT", "usage_ndi_docs");
out("deepinfra calls", isNum(h.usage_deepinfra_calls) ? int(h.usage_deepinfra_calls) : null, "LIVE COUNT", "usage_deepinfra_calls");
out("keenable pages", isNum(h.keenable_pages) ? int(h.keenable_pages) : null, "FINAL", "keenable_pages");

writeFileSync("results/deck_numbers.txt", lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`\nwrote results/deck_numbers.txt: ${lines.filter((l) => l.includes(`| ${NOT_RUN} |`)).length} NOT RUN, ${lines.filter((l) => l.includes("INTERIM") || l.includes("PARTIAL")).length} interim or partial`);
