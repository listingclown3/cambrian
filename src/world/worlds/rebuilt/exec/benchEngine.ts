/**
 * Engine benchmark (owner: P1): full scripted matches per second and answer-key-length rollouts
 * per second on one core.
 *
 *   pnpm world:bench-engine                     # 20 matches, 200 rollouts
 *   pnpm world:bench-engine -- --matches 50 --rollouts 1000 --threads 8
 *
 * Also runs the same rollouts on the worker pool and checks the results match the main thread.
 */
import { performance } from "node:perf_hooks";
import { engine } from "../engine";
import { loadConfig } from "../../../../util/config";
import { demoRobots } from "./demoMatch";
import { MatchRunner } from "./matchRunner";
import { basicCyclePolicy } from "./policies";
import { RolloutPool, runRolloutBatch } from "./rolloutPool";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const cfg = loadConfig();
const matches = arg("matches", 20);
const rollouts = arg("rollouts", 200);
const policies = { default: basicCyclePolicy };

// warm-up (JIT, navigation grid and flow-field caches)
new MatchRunner(engine, cfg, 1, demoRobots(cfg), policies).runToEnd();

/** CPU milliseconds used by this process (less sensitive than wall time to other load on the machine). */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
let t0 = performance.now();
let c0 = cpuMs();
let ticks = 0;
for (let i = 0; i < matches; i++) ticks += new MatchRunner(engine, cfg, cfg.seeds.dev[i % cfg.seeds.dev.length]! + i, demoRobots(cfg), policies).runToEnd().ticks;
const matchMs = performance.now() - t0;
const matchCpu = cpuMs() - c0;

// Rollouts from a mid-teleop snapshot, the way the answer key uses them.
const runner = new MatchRunner(engine, cfg, cfg.seeds.dev[0]!, demoRobots(cfg), policies);
while (runner.state.timeS < cfg.game.autoS.value + 30) runner.tick();
const snap = engine.snapshot(runner.state);
t0 = performance.now();
c0 = cpuMs();
for (let i = 0; i < rollouts; i++) engine.rollout(snap, {}, cfg.answerKey.horizonS, i, policies, { perspective: "blue" });
const rolloutMs = performance.now() - t0;
const rolloutCpu = cpuMs() - c0;

const rate = (n: number, ms: number) => ((n * 1000) / ms).toFixed(2);
console.log(`matches:  ${matches} in ${matchMs.toFixed(0)} ms wall = ${rate(matches, matchMs)} matches/s (${rate(matches, matchCpu)}/s per CPU second, ${rate(ticks, matchCpu)} ticks/CPU s)`);
console.log(`rollouts: ${rollouts} x ${cfg.answerKey.horizonS} s in ${rolloutMs.toFixed(0)} ms wall = ${rate(rollouts, rolloutMs)} rollouts/s (${rate(rollouts, rolloutCpu)}/s per CPU second)`);

// The same rollouts on the worker pool; results must match the main thread exactly.
const pool = new RolloutPool(process.argv.includes("--threads") ? { threads: arg("threads", 1) } : {});
const task = { snapshot: snap, overrides: {}, horizonS: cfg.answerKey.horizonS, seeds: Array.from({ length: rollouts }, (_, i) => i), policies: { default: basicCyclePolicy.id }, options: { perspective: "blue" as const } };
await pool.runBatch({ ...task, seeds: task.seeds.slice(0, pool.threads) }); // warm the workers
t0 = performance.now();
const pooled = await pool.runBatch(task);
const poolMs = performance.now() - t0;
await pool.destroy();
const inline = runRolloutBatch({ ...task, seeds: task.seeds.slice(0, Math.min(20, rollouts)) });
const same = inline.every((r, i) => JSON.stringify(r) === JSON.stringify(pooled[i]));
console.log(`pool:     ${rollouts} rollouts on ${pool.threads} workers in ${poolMs.toFixed(0)} ms wall = ${rate(rollouts, poolMs)} rollouts/s; matches main thread: ${same}`);
if (!same) process.exitCode = 1;
