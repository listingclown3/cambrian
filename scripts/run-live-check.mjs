#!/usr/bin/env node
/**
 * node scripts/run-live-check.mjs --seeds 9001,9002,... [--deciders drex,deepinfra,random] [--record-seed 9001]
 *
 * Plays real-time matches in "decider proposes, simulator checks" mode (pnpm steer:match
 * --check rollouts): blue is driven by the decider, red by the scripted policy, on EVAL seeds,
 * paired across deciders, with the scripted-vs-scripted score on the same seeds as the reference.
 * `random` is the control: a random proposer with the same check, which shows how much of the
 * result comes from the check itself rather than from the decider.
 *
 * Each decider's matches run one at a time (so limiter queueing is not charged to its clock);
 * the deciders run side by side. Results go to results/bench_live_check.json, re-written after
 * every match so a partial run is still usable. Nothing is estimated: a match that fails or falls
 * back for more than 20 percent of its decisions is listed as excluded with the reason.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const seeds = arg("seeds", "9001,9002,9003,9004,9005,9006,9007,9008").split(",").map(Number);
const deciders = arg("deciders", "drex,deepinfra,random").split(",");
const recordSeed = Number(arg("record-seed", "0"));
const OUT = "results/bench_live_check.json";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(pnpm, args, { shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
const num = (re, text) => {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
};

function parseAgent(out) {
  const score = /final score: blue (\d+) \(([^)]+)\) - red (\d+)/.exec(out);
  if (!score) return null;
  return {
    blue: Number(score[1]),
    red: Number(score[3]),
    model: /blue\s+\S+ \(([^)]+)\):/.exec(out)?.[1] ?? null,
    robotDecisions: num(/(\d+) robot decisions/, out),
    fallbacks: num(/(\d+) fallbacks/, out),
    chargedS: num(/charged ([\d.]+) match s/, out),
    latencyP50Ms: num(/p50 (\d+) ms, p95/, out),
    costUsd: num(/\$([\d.]+)\s*$/m, out),
    fastFailed: num(/fast-failed (\d+)/, out),
    completedCycles: num(/completed cycles (\d+)/, out),
    idleRobotS: num(/idle ([\d.]+) robot-s/, out),
    roleContinuationRobotS: num(/role continuation ([\d.]+) robot-s/, out),
    checked: num(/(\d+) checked/, out),
    acceptRatePct: num(/accept rate (\d+)%/, out),
    replacedByScripted: num(/replaced by scripted (\d+)/, out),
    replacedBySecondPick: num(/by second pick (\d+)/, out),
    meanMarginGain: num(/mean margin gain ([\d.-]+)/, out),
    checkP50Ms: num(/check time p50 (\d+) ms/, out),
    wallS: num(/wall ([\d.]+) s/, out),
  };
}

const rows = [];
const reference = {};
const stats = (xs) => {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, ci95: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: Number(mean.toFixed(1)), ci95: n > 1 ? Number(((1.96 * sd) / Math.sqrt(n)).toFixed(1)) : null };
};

function write(done) {
  const ok = (d) => rows.filter((r) => r.decider === d && !r.excluded && reference[r.seed] !== undefined);
  const conditions = {};
  for (const d of deciders) {
    const rs = ok(d);
    conditions[`${d}_check_realtime`] = {
      model: rs[0]?.model ?? null,
      margin: stats(rs.map((r) => r.blue - r.red)),
      marginMinusScriptedReference: stats(rs.map((r) => r.blue - r.red - reference[r.seed])),
      acceptRatePct: stats(rs.map((r) => r.acceptRatePct).filter((v) => v !== null)),
      checkP50Ms: stats(rs.map((r) => r.checkP50Ms).filter((v) => v !== null)),
      chargedS: stats(rs.map((r) => r.chargedS).filter((v) => v !== null)),
      robotDecisions: stats(rs.map((r) => r.robotDecisions).filter((v) => v !== null)),
      fallbacksTotal: rs.reduce((a, r) => a + (r.fallbacks ?? 0), 0),
      wallS: stats(rs.map((r) => r.wallS).filter((v) => v !== null)),
      excluded: rows.filter((r) => r.decider === d && r.excluded).map((r) => ({ seed: r.seed, reason: r.excluded })),
    };
  }
  const paired = (a, b) => {
    const xs = [];
    for (const s of seeds) {
      const ra = rows.find((r) => r.decider === a && r.seed === s && !r.excluded);
      const rb = rows.find((r) => r.decider === b && r.seed === s && !r.excluded);
      if (ra && rb) xs.push(ra.blue - ra.red - (rb.blue - rb.red));
    }
    return stats(xs);
  };
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
  const headlineFile = existsSync("results/headline.json") ? JSON.parse(readFileSync("results/headline.json", "utf8")) : null;
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        experiment: "bench_live_check",
        createdTs: new Date().toISOString(),
        isMock: false,
        gitCommit: git("rev-parse", "--short=12", "HEAD"),
        simHash: headlineFile?.simHash ?? "see gitCommit",
        config: {
          mode: "decider proposes, simulator checks (pnpm steer:match --check rollouts): candidates are the decider's pick, the scripted role pick and, when the decider reports probabilities, its second pick; each scored with micro-rollouts; ties keep the decider's pick",
          timing: "realtime: provider latency AND the check's wall time are charged to the sim clock, for every decider",
          blue: "driven by the decider",
          red: "scripted archetype policy",
          seeds,
          seedSet: "eval",
          fairnessRules: "commitment, no-idle and anti-loop rules on, identical for every decider",
          control: "random = uniform random proposer with the same check",
          complete: done,
        },
        rows,
        summary: {
          scriptedReferenceMargin: stats(Object.values(reference)),
          conditions,
          paired: { drex_minus_giant: paired("drex", "deepinfra"), drex_minus_random: paired("drex", "random"), giant_minus_random: paired("deepinfra", "random") },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

// Scripted reference first: free and fast.
for (const seed of seeds) {
  const r = await run(["-s", "match", "--", "--seed", String(seed)]);
  const blue = num(/blue\s+(\d+) \(fuel/, r.out);
  const red = num(/red\s+(\d+) \(fuel/, r.out);
  if (blue !== null && red !== null) reference[seed] = blue - red;
  console.log(`reference seed ${seed}: blue ${blue} red ${red}`);
}
write(false);

await Promise.all(
  deciders.map(async (decider) => {
    for (const seed of seeds) {
      const args = ["-s", "steer:match", "--", "--blue", decider, "--red", "scripted", "--timing", "realtime", "--seed", String(seed), "--check", "rollouts"];
      if (seed === recordSeed && decider !== "random") args.push("--record", `recorded-showcase-${decider === "deepinfra" ? "giant" : decider}`);
      const r = await run(args);
      const parsed = parseAgent(r.out);
      const row = { decider, seed, ...(parsed ?? {}) };
      if (!parsed) row.excluded = `match failed (exit ${r.code}): ${r.out.replace(/\s+/g, " ").slice(-160)}`;
      else if (parsed.robotDecisions && (parsed.fallbacks ?? 0) / parsed.robotDecisions > 0.2) row.excluded = `more than 20 percent fallbacks (${parsed.fallbacks} of ${parsed.robotDecisions})`;
      rows.push(row);
      console.log(`${decider} seed ${seed}: ${parsed ? `blue ${parsed.blue} red ${parsed.red} accept ${parsed.acceptRatePct}% fallbacks ${parsed.fallbacks}` : "FAILED"}${row.excluded ? ` EXCLUDED: ${row.excluded}` : ""}`);
      write(false);
    }
  }),
);
write(true);
console.log(`wrote ${OUT}`);
