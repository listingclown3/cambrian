/**
 * pnpm nace:answerkey [-- --rollouts 100 --horizon end --workers 11 --in scenarios.json --out raw_key.json --results answerkey]
 * pnpm nace:answerkey -- --shard I/N --out results/answerkey.shard-I.json [same settings]
 * pnpm nace:answerkey -- --merge results/answerkey.shard-1.json results/answerkey.shard-2.json ... [--in/--out/--results]
 * (owner: P3)
 *
 * For every scenario and option: n rollouts (engine.rollout; the focus robot starts with the
 * option, every robot then follows the default scripted policy) over the horizon ("end" = to the
 * end of the match), giving mean margin (pointsFor - pointsAgainst), 95% CI half-width (Student
 * t) and n. Common random numbers: every option of a scenario uses the same rollout seeds.
 * Ambiguous = the PAIRED difference best minus runner-up (same seeds) has a 95% CI that
 * includes 0. The unpaired interval-overlap test is also stored (ambiguousUnpaired).
 * Fixed rule (isExcludedOption): climb options only when time left <= endgame (30 s) + 5 s.
 *
 * Shards (edge compute): --shard I/N takes the scenarios whose index in the input set is
 * congruent to I-1 mod N, needs no network or API keys, and writes a shard file with simHash,
 * git commit, settings and per-option margins. --merge refuses unless every shard has the same
 * simHash, commit, rollouts, horizon, rule and N, and the shards cover every scenario exactly once.
 *
 * Writes the keys into data/scenarios/<out> and results/<results>.json (not for --shard).
 */
import os from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Tinypool from "tinypool";
import type { AnswerKey } from "../../../src/contracts";
import { ENGINE_IS_STUB } from "../../../src/world/worlds/rebuilt/engine";
import { DEFAULT_POLICY_ID } from "../../../src/world/worlds/rebuilt/exec/policies";
import { loadConfig, repoPath } from "../../../src/util/config";
import { gitCommit, simHash } from "../../../src/util/provenance";
import { hashString } from "../../../src/util/rng";
import { writeResults } from "../../../src/util/runLog";
import { CLIMB_RULE, ScenarioSetSchema, ci95, isExcludedOption, loadScenarioSet, mean, round, writeJson } from "./common";
import type { RolloutTask } from "./answerkeyWorker";

const argv = process.argv;
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const n = Number(arg("rollouts", String(cfg.answerKey.rollouts)));
const horizonArg = arg("horizon", String(cfg.answerKey.horizonS));
const horizonS = horizonArg === "end" ? 1000 : Number(horizonArg);
const workers = Number(arg("workers", String(Math.max(1, os.cpus().length - 1))));
const inFile = arg("in", "scenarios.json");
const outFile = arg("out", inFile);
const resultsName = arg("results", "answerkey");
const shardArg = argv.includes("--shard") ? arg("shard", "") : null;
const mergeIdx = argv.indexOf("--merge");
const mergeFiles = mergeIdx >= 0 ? (() => { const rest = argv.slice(mergeIdx + 1); const stop = rest.findIndex((a) => a.startsWith("--")); return stop < 0 ? rest : rest.slice(0, stop); })() : null;

const set = loadScenarioSet(inFile);
const file = repoPath("data", "scenarios", inFile);
for (const s of set.scenarios) s.options = s.options.filter((o) => !isExcludedOption(s, o.label));
const settings = { simHash: simHash(cfg), gitCommit: gitCommit(), rollouts: n, horizon: horizonArg, rule: CLIMB_RULE, rolloutPolicy: DEFAULT_POLICY_ID, inFile, scenarioSetGeneratedTs: set.generatedTs };

type Margins = Record<string, Record<string, number[]>>; // scenarioId -> label -> margins (seed order)

async function computeMargins(indices: number[]): Promise<{ margins: Margins; rollouts: number; wallS: number }> {
  const pool = new Tinypool({ filename: pathToFileURL(repoPath("experiments", "nace-2026", "bench", "answerkeyWorker.ts")).href, minThreads: workers, maxThreads: workers, execArgv: ["--import", "tsx"] });
  const t0 = performance.now();
  const CHUNK = 10;
  const jobs: Promise<void>[] = [];
  const margins: Margins = {};
  let rollouts = 0;
  for (const scenarioIdx of indices) {
    const s = set.scenarios[scenarioIdx]!;
    const seeds = Array.from({ length: n }, (_, i) => (hashString(`${s.id}:${i}`) >>> 0) % 2_000_000_000);
    margins[s.id] = {};
    for (const o of s.options) {
      const arr = (margins[s.id]![o.label] = new Array<number>(n));
      for (let c = 0; c < n; c += CHUNK) {
        const task: RolloutTask = { file, scenarioIdx, label: o.label, seeds: seeds.slice(c, c + CHUNK), horizonS };
        jobs.push(
          pool.run(task).then((r: { margins: number[] }) => {
            r.margins.forEach((m, j) => (arr[c + j] = m));
            rollouts += r.margins.length;
          }),
        );
      }
    }
  }
  await Promise.all(jobs);
  await pool.destroy();
  return { margins, rollouts, wallS: (performance.now() - t0) / 1000 };
}

function keyOf(byLabel: Record<string, number[]>): AnswerKey & { ambiguousUnpaired: boolean; pairedGap: { mean: number; ci95: number } | null } {
  const values: AnswerKey["values"] = {};
  for (const [label, ms] of Object.entries(byLabel)) values[label] = { mean: mean(ms), ci95: ci95(ms), n: ms.length };
  const ranked = Object.entries(values).sort((a, b) => b[1].mean - a[1].mean);
  const [best, second] = ranked;
  if (!second) return { values, best: best![0], ambiguous: false, ambiguousUnpaired: false, pairedGap: null };
  const diffs = byLabel[best![0]]!.map((m, i) => m - byLabel[second[0]]![i]!);
  const gap = { mean: mean(diffs), ci95: ci95(diffs) };
  return { values, best: best![0], ambiguous: gap.mean - gap.ci95 <= 0, ambiguousUnpaired: best![1].mean - best![1].ci95 <= second[1].mean + second[1].ci95, pairedGap: gap };
}

function finish(margins: Margins, rollouts: number, wallS: number, extra: Record<string, unknown>) {
  const rows: Record<string, unknown>[] = [];
  for (const s of set.scenarios) {
    const k = keyOf(margins[s.id]!);
    s.answerKey = { values: k.values, best: k.best, ambiguous: k.ambiguous };
    const ranked = Object.entries(k.values).sort((a, b) => b[1].mean - a[1].mean);
    rows.push({ scenarioId: s.id, familyId: s.familyId, flip: s.flip, nOptions: s.options.length, best: k.best, bestMean: round(ranked[0]![1].mean), bestCi95: round(ranked[0]![1].ci95), second: ranked[1]?.[0] ?? null, secondMean: round(ranked[1]?.[1].mean ?? NaN), pairedGap: k.pairedGap ? { mean: round(k.pairedGap.mean), ci95: round(k.pairedGap.ci95) } : null, ambiguous: k.ambiguous, ambiguousUnpaired: k.ambiguousUnpaired, spread: round(ranked[0]![1].mean - ranked[ranked.length - 1]![1].mean) });
  }
  writeJson(ScenarioSetSchema.parse({ ...set, simHash: settings.simHash }), "data", "scenarios", outFile);
  const out = writeResults({
    experiment: resultsName,
    createdTs: new Date().toISOString(),
    isMock: ENGINE_IS_STUB,
    gitCommit: settings.gitCommit,
    simHash: settings.simHash,
    config: { ...settings, horizonS, configAnswerKey: cfg.answerKey, workers, ambiguity: "paired best-minus-runner-up 95% CI includes 0 (common random numbers)", seeds: "rollout seed i of scenario s = fnv1a(`${s}:${i}`), shared by all options; scenarios mined from dev-seed matches", ...extra },
    rows,
    summary: { n_scenarios: set.scenarios.length, n_families: set.families.length, n_unambiguous: rows.filter((r) => !r.ambiguous).length, n_unambiguous_unpaired: rows.filter((r) => !r.ambiguousUnpaired).length, rollouts_total: rollouts, rollouts_per_option: n, horizon: horizonArg, wall_s: round(wallS, 1), rollouts_per_sec: wallS > 0 ? round(rollouts / wallS, 1) : null },
  });
  console.log(`[answerkey] ${rollouts} rollouts, ${rows.filter((r) => !r.ambiguous).length}/${rows.length} unambiguous (paired) -> data/scenarios/${outFile}, ${out}`);
  for (const r of rows) console.log(`  ${String(r.scenarioId).padEnd(40)} best ${String(r.best).padEnd(28)} ${r.bestMean} gap ${(r.pairedGap as any)?.mean}±${(r.pairedGap as any)?.ci95} ${r.ambiguous ? "AMBIGUOUS" : ""}`);
}

if (mergeFiles) {
  if (mergeFiles.length === 0) throw new Error("--merge needs shard files");
  const shards = mergeFiles.map((f) => ({ f, d: JSON.parse(readFileSync(path.resolve(f), "utf8")) }));
  const first = shards[0]!.d;
  for (const { f, d } of shards) {
    for (const k of ["simHash", "gitCommit", "rollouts", "horizon", "rule", "rolloutPolicy", "scenarioSetGeneratedTs"] as const) {
      if (JSON.stringify(d.settings[k]) !== JSON.stringify(first.settings[k])) throw new Error(`refusing to merge: ${f} has ${k}=${JSON.stringify(d.settings[k])}, first shard has ${JSON.stringify(first.settings[k])}`);
    }
    if (d.shard.of !== first.shard.of) throw new Error(`refusing to merge: ${f} is a shard of ${d.shard.of}, first is of ${first.shard.of}`);
  }
  if (first.settings.simHash !== settings.simHash) throw new Error(`refusing to merge: shards have simHash ${first.settings.simHash}, this checkout has ${settings.simHash}`);
  if (first.settings.rollouts !== n || first.settings.horizon !== horizonArg) throw new Error(`refusing to merge: pass the shards' --rollouts ${first.settings.rollouts} --horizon ${first.settings.horizon}`);
  const margins: Margins = {};
  for (const { f, d } of shards) for (const [id, m] of Object.entries(d.margins as Margins)) {
    if (margins[id]) throw new Error(`refusing to merge: scenario ${id} appears in more than one shard (${f})`);
    margins[id] = m;
  }
  const missing = set.scenarios.filter((s) => !margins[s.id]).map((s) => s.id);
  if (missing.length) throw new Error(`refusing to merge: shards do not cover ${missing.join(", ")}`);
  if (Object.keys(margins).length !== set.scenarios.length) throw new Error("refusing to merge: shards contain scenarios not in the input set");
  finish(margins, shards.reduce((k, s) => k + s.d.rollouts, 0), Math.max(...shards.map((s) => s.d.wallS)), { mergedFrom: shards.map((s) => ({ file: s.f, shard: s.d.shard, host: s.d.host })) });
} else if (shardArg !== null) {
  const m = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (!m) throw new Error("--shard must be I/N, e.g. 1/3");
  const I = Number(m[1]);
  const N = Number(m[2]);
  if (I < 1 || I > N) throw new Error("--shard I/N needs 1 <= I <= N");
  const indices = set.scenarios.map((_, i) => i).filter((i) => i % N === I - 1);
  const r = await computeMargins(indices);
  const target = argv.includes("--out") ? path.resolve(arg("out", "")) : repoPath("results", `answerkey.shard-${I}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ settings, shard: { index: I, of: N, scenarioIds: indices.map((i) => set.scenarios[i]!.id) }, host: os.hostname(), cpus: os.cpus().length, rollouts: r.rollouts, wallS: r.wallS, createdTs: new Date().toISOString(), margins: r.margins }) + "\n");
  console.log(`[answerkey] shard ${I}/${N}: ${indices.length} scenarios, ${r.rollouts} rollouts in ${r.wallS.toFixed(1)} s; simHash ${settings.simHash}, commit ${settings.gitCommit} -> ${target}`);
} else {
  const r = await computeMargins(set.scenarios.map((_, i) => i));
  finish(r.margins, r.rollouts, r.wallS, {});
}
