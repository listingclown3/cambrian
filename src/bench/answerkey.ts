/**
 * pnpm answerkey [-- --rollouts 50 --horizon 20 --workers 11] (owner: P3)
 * For every scenario and option: config.answerKey.rollouts rollouts of config.answerKey.horizonS
 * (engine.rollout; the focus robot starts with the option, everyone else follows basic_cycle),
 * mean margin (pointsFor - pointsAgainst), 95% CI half-width (Student t) and n. The same rollout
 * seeds are used for every option of a scenario (common random numbers). A scenario is ambiguous
 * when the best option's interval overlaps the runner-up's. Runs on tinypool worker threads.
 *
 * Writes the answer keys into data/scenarios/scenarios.json and results/answerkey.json.
 */
import os from "node:os";
import { pathToFileURL } from "node:url";
import Tinypool from "tinypool";
import type { AnswerKey } from "../contracts";
import { ENGINE_IS_STUB } from "../engine";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { hashString } from "../util/rng";
import { writeResults } from "../util/runLog";
import { ScenarioSetSchema, ci95, loadScenarioSet, mean, round, writeJson } from "./common";
import type { RolloutTask } from "./answerkeyWorker";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const n = Number(arg("rollouts", String(cfg.answerKey.rollouts)));
const horizonS = Number(arg("horizon", String(cfg.answerKey.horizonS)));
const workers = Number(arg("workers", String(Math.max(1, os.cpus().length - 1))));
const set = loadScenarioSet();
const file = repoPath("data", "scenarios", "scenarios.json");

const pool = new Tinypool({
  filename: pathToFileURL(repoPath("src", "bench", "answerkeyWorker.ts")).href,
  minThreads: workers,
  maxThreads: workers,
  execArgv: ["--import", "tsx"],
});

const t0 = performance.now();
const CHUNK = 10;
const jobs: Promise<void>[] = [];
const margins = new Map<string, number[]>();
let rollouts = 0;
set.scenarios.forEach((s, scenarioIdx) => {
  const seeds = Array.from({ length: n }, (_, i) => (hashString(`${s.id}:${i}`) >>> 0) % 2_000_000_000);
  for (const o of s.options) {
    const key = `${s.id}\u0000${o.label}`;
    margins.set(key, new Array<number>(n));
    for (let c = 0; c < n; c += CHUNK) {
      const chunk = seeds.slice(c, c + CHUNK);
      const task: RolloutTask = { file, scenarioIdx, label: o.label, seeds: chunk, horizonS };
      jobs.push(
        pool.run(task).then((r: { margins: number[] }) => {
          r.margins.forEach((m, j) => (margins.get(key)![c + j] = m));
          rollouts += r.margins.length;
        }),
      );
    }
  }
});
await Promise.all(jobs);
await pool.destroy();
const wallS = (performance.now() - t0) / 1000;

const rows: Record<string, unknown>[] = [];
for (const s of set.scenarios) {
  const values: AnswerKey["values"] = {};
  for (const o of s.options) {
    const ms = margins.get(`${s.id}\u0000${o.label}`)!;
    values[o.label] = { mean: mean(ms), ci95: ci95(ms), n: ms.length };
  }
  const ranked = Object.entries(values).sort((a, b) => b[1].mean - a[1].mean);
  const [best, second] = ranked;
  const ambiguous = second ? best![1].mean - best![1].ci95 <= second[1].mean + second[1].ci95 : false;
  s.answerKey = { values, best: best![0], ambiguous };
  rows.push({ scenarioId: s.id, familyId: s.familyId, nOptions: s.options.length, best: best![0], bestMean: round(best![1].mean), bestCi95: round(best![1].ci95), secondMean: round(second?.[1].mean ?? NaN), ambiguous, spread: round(best![1].mean - ranked[ranked.length - 1]![1].mean) });
}
writeJson(ScenarioSetSchema.parse(set), "data", "scenarios", "scenarios.json");
const out = writeResults({
  experiment: "answerkey",
  createdTs: new Date().toISOString(),
  isMock: ENGINE_IS_STUB,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { rolloutsPerOption: n, horizonS, configAnswerKey: cfg.answerKey, workers, rolloutPolicy: "basic_cycle for every robot not overridden", seeds: "rollout seed i of scenario s = fnv1a(`${s}:${i}`), shared by all options (common random numbers); scenarios come from dev-seed matches" },
  rows,
  summary: {
    n_scenarios: set.scenarios.length,
    n_families: set.families.length,
    n_unambiguous: rows.filter((r) => !r.ambiguous).length,
    rollouts_total: rollouts,
    rollouts_per_option: n,
    horizon_s: horizonS,
    wall_s: round(wallS, 1),
    rollouts_per_sec: round(rollouts / wallS, 1),
  },
});
console.log(`[answerkey] ${rollouts} rollouts in ${wallS.toFixed(1)} s on ${workers} workers; ${rows.filter((r) => !r.ambiguous).length}/${rows.length} unambiguous -> ${out}`);
for (const r of rows) console.log(`  ${String(r.scenarioId).padEnd(40)} best ${String(r.best).padEnd(28)} ${r.bestMean} ±${r.bestCi95} (2nd ${r.secondMean}) ${r.ambiguous ? "AMBIGUOUS" : ""}`);
