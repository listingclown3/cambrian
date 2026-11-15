/**
 * pnpm explore (owner: P3)
 * How many rollouts does a search need before it has evaluated the answer-key best option, when
 * options are evaluated one at a time with R rollouts each (R = config.answerKey.rollouts, the
 * per-option budget the answer key itself used) in the order given by:
 *   drex     - Drex's (drex-v2.0) probabilities from bench_scenarios, highest first
 *   deepinfra- the giant's single pick first, the rest in uniform random order (it returns no
 *              probabilities)
 *   uniform  - uniform random order
 * Ties and random orders are scored by their exact expectation (no sampling): the expected
 * position of the best option. rollouts_to_best = R * expected position. No new model calls:
 * it reuses the answers recorded in results/scenarios.json.
 * Unambiguous scenarios only (where "the best option" is well defined); all-scenario numbers are
 * reported alongside.
 *
 * Writes results/bench_explore.json.
 */
import { loadConfig } from "../../../src/util/config";
import { gitCommit, simHash } from "../../../src/util/provenance";
import { writeResults } from "../../../src/util/runLog";
import { mean, readJson, round } from "./common";

const cfg = loadConfig();
const R = cfg.answerKey.rollouts;
const sc = readJson("results", "scenarios.json");
if (!sc) throw new Error("results/scenarios.json is missing: run pnpm nace:scenarios first");

function posFromProbs(labels: string[], probs: Record<string, number> | undefined, best: string): number | null {
  if (!probs) return null;
  const p = probs[best] ?? 0;
  const ahead = labels.filter((l) => l !== best && (probs[l] ?? 0) > p).length;
  const ties = labels.filter((l) => l !== best && (probs[l] ?? 0) === p).length;
  return 1 + ahead + ties / 2;
}

const rows: Record<string, unknown>[] = [];
for (const s of sc.scenarios as any[]) {
  const labels: string[] = s.options.map((o: any) => o.label);
  const k = labels.length;
  const best: string = s.answerKey.best;
  const drex = sc.picks[s.id]?.drex;
  const giant = sc.picks[s.id]?.deepinfra;
  const uniformPos = (k + 1) / 2;
  const drexPos = drex ? posFromProbs(labels, drex.probabilities, best) : null;
  const giantPos = giant?.label ? (giant.label === best ? 1 : 1 + k / 2) : null;
  rows.push({
    scenarioId: s.id,
    ambiguous: s.answerKey.ambiguous,
    nOptions: k,
    best,
    drexPosition: drexPos,
    giantPosition: giantPos,
    uniformPosition: uniformPos,
    rollouts_drex: drexPos === null ? null : drexPos * R,
    rollouts_deepinfra: giantPos === null ? null : giantPos * R,
    rollouts_uniform: uniformPos * R,
  });
}

function agg(filter: (r: any) => boolean) {
  const sel = rows.filter(filter);
  const both = sel.filter((r: any) => r.rollouts_drex !== null && r.rollouts_deepinfra !== null);
  const d = mean(both.map((r: any) => r.rollouts_drex));
  const g = mean(both.map((r: any) => r.rollouts_deepinfra));
  const u = mean(both.map((r: any) => r.rollouts_uniform));
  return { n: both.length, rollouts_to_best_drex: round(d, 1), rollouts_to_best_deepinfra: round(g, 1), rollouts_to_best_uniform: round(u, 1), rollout_savings_pct_drex_vs_uniform: round(100 * (1 - d / u), 1), rollout_savings_pct_deepinfra_vs_uniform: round(100 * (1 - g / u), 1) };
}

const file = writeResults({
  experiment: "bench_explore",
  createdTs: new Date().toISOString(),
  isMock: !!sc.isMock,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { rolloutsPerOption: R, source: "results/scenarios.json picks (drex = drex-v2.0 probabilities; deepinfra = giant pick, reasoning off)", scenariosSimHash: sc.simHash, method: "expected position of the answer-key best option in the search order x R; exact expectations for ties and random order" },
  rows,
  summary: { unambiguous: agg((r) => !r.ambiguous), all: agg(() => true) },
});
console.log(`[bench:explore] -> ${file}`);
console.log(JSON.stringify({ unambiguous: agg((r) => !r.ambiguous), all: agg(() => true) }));
