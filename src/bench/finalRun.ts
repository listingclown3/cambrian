/**
 * pnpm final [-- --cutoff 14:10 --n 10 --seeds eval --rollouts 100 --parts scripted,drex_realtime,drex_paused,giant_realtime,giant_paused --deciders all]
 * (owner: P3) The whole reported chain as ONE command:
 *   in parallel: bench:live parts (each its own process; Drex realtime one match at a time, so
 *   the shared Drex limiter's queue is not charged to the sim clock) and the answer key;
 *   after the key: bench:scenarios (degeneracy gate first; fresh calls on the current prompt);
 *   at the cutoff: live parts still running are stopped (every finished match is already on disk,
 *   unfinished ones are NOT RUN); then bench:live --assemble, bench:explore, headline.
 * Dry run: pnpm final -- --seeds dev --n 2 --rollouts 4 --parts scripted,giant_realtime --deciders deepinfra,scripted,random
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { repoPath } from "../util/config";

const argv = process.argv;
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const cutoff = arg("cutoff", "14:10");
const n = arg("n", "10");
const seeds = arg("seeds", "eval");
const rollouts = arg("rollouts", "100");
const parts = arg("parts", "scripted,drex_realtime,drex_paused,giant_realtime,giant_paused").split(",");
const deciders = arg("deciders", "all");
const logDir = repoPath("runs", `final-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`);
mkdirSync(logDir, { recursive: true });

function run(name: string, script: string, args: string[]): { child: ChildProcess; done: Promise<number> } {
  const out = openSync(`${logDir}/${name}.log`, "a");
  const child = spawn("pnpm", ["-s", script, "--", ...args], { cwd: repoPath(), shell: true, stdio: ["ignore", out, out] });
  console.log(`[final] start ${name}: pnpm ${script} -- ${args.join(" ")} (log ${logDir}/${name}.log)`);
  const done = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  done.then((code) => console.log(`[final] ${name} exited ${code} at ${new Date().toLocaleTimeString()}`));
  return { child, done };
}
function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
}

const parallelOf: Record<string, string> = { giant_paused: "2" };
const live = parts.map((p) => ({ p, ...run(`live_${p}`, "bench:live", ["--part", p, "--n", n, "--seeds", seeds, "--parallel", parallelOf[p] ?? "1"]) }));
const key = run("answerkey", "answerkey", ["--in", "base_scenarios.json", "--rollouts", rollouts, "--horizon", "end", "--out", "scenarios.json", "--results", "answerkey"]);

const [hh, mm] = cutoff.split(":").map(Number);
const cut = new Date();
cut.setHours(hh!, mm!, 0, 0);
const msLeft = Math.max(0, cut.getTime() - Date.now());
const timer = setTimeout(() => {
  for (const l of live) if (l.child.exitCode === null) {
    console.log(`[final] cutoff ${cutoff}: stopping live part ${l.p} (finished matches are on disk; the rest are NOT RUN)`);
    kill(l.child);
  }
}, msLeft);

const keyCode = await key.done;
if (keyCode === 0) {
  const sc = run("bench_scenarios", "bench:scenarios", deciders === "all" ? [] : ["--deciders", deciders]);
  const code = await sc.done;
  if (code === 2) console.log("[final] degeneracy gate FAILED: bench:scenarios did not score (results/bench_scenarios_gate.json)");
} else console.log("[final] answer key failed: bench:scenarios skipped");
await Promise.all(live.map((l) => l.done));
clearTimeout(timer);
for (const [name, script, args] of [
  ["assemble", "bench:live", ["--assemble"]],
  ["explore", "bench:explore", []],
  ["headline", "headline", []],
] as [string, string, string[]][]) await run(name, script, args).done;
console.log(`[final] done; logs in ${logDir}`);
