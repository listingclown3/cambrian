/**
 * pnpm rekey (owner: P3)
 * Build the answer keys that bench:scenarios scores against, from raw answer-key runs:
 *   data/scenarios/raw_key_20s.json        primary: config.answerKey (50 rollouts x 20 s), from `pnpm answerkey`
 *   data/scenarios/raw_key_match_end.json  secondary: 40 rollouts to the end of the match, from
 *                                          `pnpm answerkey -- --rollouts 40 --horizon 200`
 * and apply the fixed exclusion rule (isExcludedOption: no climb options before the end game).
 * Removing an option does not change any other option's rollouts (each option's rollouts are
 * independent and use the same seeds), so values are reused; only best and ambiguous are recomputed.
 *
 * Writes data/scenarios/scenarios.json (primary key, pruned options), data/scenarios/answerkey_match_end.json,
 * results/answerkey.json and results/answerkey_match_end.json.
 * To regenerate the raw files: run `pnpm answerkey` (writes data/scenarios/scenarios.json), copy it to
 * raw_key_20s.json; same with the match-end arguments to raw_key_match_end.json; then `pnpm rekey`.
 */
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";
import { ScenarioSetSchema, isExcludedOption, keyFromValues, loadScenarioSet, round, writeJson, type ScenarioSet } from "./common";

const cfg = loadConfig();
const primary = loadScenarioSet("raw_key_20s.json");
const secondary = loadScenarioSet("raw_key_match_end.json");

function prune(set: ScenarioSet): { set: ScenarioSet; removed: number } {
  let removed = 0;
  for (const s of set.scenarios) {
    const before = s.options.length;
    s.options = s.options.filter((o) => !isExcludedOption(s, o.label));
    removed += before - s.options.length;
    if (s.answerKey) s.answerKey = keyFromValues(Object.fromEntries(Object.entries(s.answerKey.values).filter(([l]) => !isExcludedOption(s, l))));
  }
  return { set, removed };
}

function results(experiment: string, set: ScenarioSet, horizon: string, removed: number) {
  const rows = set.scenarios.map((s) => {
    const ranked = Object.entries(s.answerKey!.values).sort((a, b) => b[1].mean - a[1].mean);
    return { scenarioId: s.id, familyId: s.familyId, phase: s.snapshot.state.phase, nOptions: s.options.length, best: s.answerKey!.best, bestMean: round(ranked[0]![1].mean), bestCi95: round(ranked[0]![1].ci95), secondMean: round(ranked[1]?.[1].mean ?? NaN), ambiguous: s.answerKey!.ambiguous, n: ranked[0]![1].n };
  });
  const bests = new Map<string, number>();
  for (const r of rows) bests.set(r.best, (bests.get(r.best) ?? 0) + 1);
  return writeResults({
    experiment,
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: set.simHash,
    config: { horizon, rule: "climb options excluded before the end game (isExcludedOption, fixed before re-scoring)", optionsRemovedByRule: removed, rolloutPolicy: "basic_cycle for every robot not overridden", seeds: "rollout seed i of scenario s = fnv1a(`${s}:${i}`), shared by all options; scenarios mined from dev-seed matches", currentSimHash: simHash(cfg) },
    rows,
    summary: {
      n_scenarios: rows.length,
      n_unambiguous: rows.filter((r) => !r.ambiguous).length,
      distinct_best_labels: bests.size,
      best_label_counts: Object.fromEntries([...bests].sort((a, b) => b[1] - a[1])),
      share_best_is_climb: round(rows.filter((r) => r.best.startsWith("climb")).length / rows.length),
      rollouts_per_option: rows[0]?.n ?? null,
    },
  });
}

const p = prune(primary);
const q = prune(secondary);
writeJson(ScenarioSetSchema.parse({ ...p.set, generatedTs: new Date().toISOString(), note: `${p.set.note} Answer key: ${cfg.answerKey.rollouts} rollouts x ${cfg.answerKey.horizonS} s per option; climb options excluded before the end game.` }), "data", "scenarios", "scenarios.json");
writeJson({ simHash: q.set.simHash, note: "Secondary answer key: 40 rollouts per option to the end of the match; same exclusion rule.", keys: Object.fromEntries(q.set.scenarios.map((s) => [s.id, s.answerKey])) }, "data", "scenarios", "answerkey_match_end.json");
console.log(`[rekey] primary -> ${results("answerkey", p.set, `${cfg.answerKey.horizonS} s`, p.removed)}`);
console.log(`[rekey] secondary -> ${results("answerkey_match_end", q.set, "to match end", q.removed)}`);
