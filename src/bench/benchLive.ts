/**
 * pnpm bench:live -- --part <part> [--n 5] [--parallel 1]     play one part
 * pnpm bench:live -- --assemble                               merge the parts
 * (owner: P3)
 *
 * Full matches on EVAL seeds (the first n of config.seeds.eval). Per seed, one league line-up
 * (drawLineup "live:<seed>"); BLUE is driven by the decider through the AgentController's batched
 * path (all blue robots that decide on one tick share one request), RED always plays the scripted
 * basic_cycle policy. Margin = blue total - red total. The same seeds and line-ups are used for
 * every decider (paired).
 *
 * Parts (each writes results/bench_live_<part>.json; run giant parts in separate processes so each
 * gets its own provider concurrency limiter and realtime latencies are not inflated by queueing):
 *   scripted        blue scripted too (control, no model calls)
 *   drex            drex-v2.0, realtime and paused
 *   giant_realtime  the giant (deepinfra, reasoning OFF), realtime (latency on the sim clock)
 *   giant_paused    the giant, paused (the match waits while it thinks)
 * Realtime: latency charged on the sim clock (config.realtimeLatencyCharging.latencyScale).
 * Wall time per match is measured around AgentController.run(); with --parallel 1 matches run one
 * at a time, so wall time is not shared between matches.
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import type { Alliance } from "../contracts";
import { AgentController, type AllianceAgent, type TimingMode } from "../decide/controller";
import { getProviderBySpec } from "../decide/registry";
import { ENGINE_IS_STUB, engine } from "../engine";
import { basicCyclePolicy } from "../exec";
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";
import { ci95, drawLineup, loadLeague, mean, pct, readJson, round } from "./common";
import pLimit from "p-limit";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const PARTS: Record<string, { spec: string | null; timings: TimingMode[]; decider: string }> = {
  scripted: { spec: null, timings: ["paused"], decider: "scripted" },
  drex: { spec: "drex", timings: ["realtime", "paused"], decider: "drex" },
  giant_realtime: { spec: "deepinfra", timings: ["realtime"], decider: "deepinfra" },
  giant_paused: { spec: "deepinfra", timings: ["paused"], decider: "deepinfra" },
};

async function playPart(part: string, n: number, parallel: number) {
  const def = PARTS[part];
  if (!def) throw new Error(`unknown part ${part}; known: ${Object.keys(PARTS).join(", ")}`);
  const league = loadLeague();
  const seeds = cfg.seeds.eval.slice(0, n);
  const limit = pLimit(parallel);
  const rows: Record<string, unknown>[] = [];
  const jobs = def.timings.flatMap((timing) =>
    seeds.map((seed) =>
      limit(async () => {
        const robots = drawLineup(league, `live:${seed}`, { blue: def.spec ?? "basic_cycle", red: "basic_cycle" });
        const agents: Partial<Record<Alliance, AllianceAgent>> = def.spec ? { blue: { provider: getProviderBySpec(def.spec, cfg, { purpose: "bench_live" }) } } : {};
        const t0 = performance.now();
        const s = await new AgentController({ engine, cfg, seed, robots, agents, scripted: { default: basicCyclePolicy }, timing }).run();
        const wallS = (performance.now() - t0) / 1000;
        const metas = s.decisions.flatMap((d) => d.metas);
        const lat = metas.map((m) => m.latencyMs);
        const row = {
          part,
          decider: def.decider,
          timing,
          seed,
          blue: robots.filter((r) => r.alliance === "blue").map((r) => r.profile.id),
          red: robots.filter((r) => r.alliance === "red").map((r) => r.profile.id),
          scoreBlue: s.state.score.blue!.total,
          scoreRed: s.state.score.red!.total,
          margin: s.state.score.blue!.total - s.state.score.red!.total,
          requests: s.decisions.length,
          providerCalls: s.calls.blue,
          robotDecisions: s.decisions.reduce((k, d) => k + d.choices.length, 0),
          fallbacks: s.fallbacks.blue,
          fallbackMetas: metas.filter((m) => m.fallbackUsed).length,
          dropped: s.dropped,
          chargedS: round(s.chargedS.blue, 3),
          wallS: round(wallS, 2),
          latencyP50Ms: lat.length ? round(pct(lat, 0.5), 1) : null,
          latencyP95Ms: lat.length ? round(pct(lat, 0.95), 1) : null,
          costUsd: round(metas.reduce((k, m) => k + m.costUsd, 0), 6),
          models: [...new Set(metas.map((m) => m.model))],
          isMock: metas.some((m) => m.isMock),
        };
        rows.push(row);
        console.log(`[bench:live] ${part} ${timing} seed ${seed}: margin ${row.margin} (${row.scoreBlue}-${row.scoreRed}), ${row.robotDecisions} robot decisions in ${row.requests} requests, ${row.fallbacks} fallbacks, charged ${row.chargedS} s, wall ${row.wallS} s, $${row.costUsd}`);
      }),
    ),
  );
  await Promise.all(jobs);
  rows.sort((a, b) => String(a.timing).localeCompare(String(b.timing)) || (a.seed as number) - (b.seed as number));
  writeResults({
    experiment: `bench_live_${part}`,
    createdTs: new Date().toISOString(),
    isMock: ENGINE_IS_STUB || rows.some((r) => r.isMock),
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { part, spec: def.spec, reasoning: def.decider === "deepinfra" ? "off" : null, seeds: { dev: [], eval: seeds }, parallel, realtimeLatencyCharging: cfg.realtimeLatencyCharging, lineup: "drawLineup(league, `live:${seed}`): blue = decider, red = scripted basic_cycle" },
    rows,
    summary: {},
  });
}

function stats(rows: any[]) {
  const m = rows.map((r) => r.margin as number);
  return { n: rows.length, seeds: rows.map((r) => r.seed), mean_margin: round(mean(m), 2), ci95: round(ci95(m), 2) };
}

function assemble() {
  const parts = Object.keys(PARTS).map((p) => ({ part: p, file: readJson(`results`, `bench_live_${p}.json`) })).filter((x) => x.file);
  const rows: any[] = parts.flatMap((p) => p.file.rows);
  const hashes = [...new Set(parts.map((p) => p.file.simHash))];
  const group = (decider: string, timing: string) => rows.filter((r) => r.decider === decider && r.timing === timing);
  const conds: Record<string, any> = {};
  for (const [decider, timing] of [["scripted", "paused"], ["drex", "realtime"], ["drex", "paused"], ["deepinfra", "realtime"], ["deepinfra", "paused"]] as const) {
    const g = group(decider, timing);
    if (g.length === 0) continue;
    const wall = g.map((r) => r.wallS as number);
    conds[`${decider}_${timing}`] = {
      ...stats(g),
      mean_robot_decisions_per_match: round(mean(g.map((r) => r.robotDecisions)), 1),
      mean_requests_per_match: round(mean(g.map((r) => r.requests)), 1),
      mean_wall_s_per_match: round(mean(wall), 2),
      mean_charged_s_per_match: round(mean(g.map((r) => r.chargedS)), 2),
      fallbacks_total: g.reduce((k, r) => k + r.fallbacks, 0),
      dropped_total: g.reduce((k, r) => k + r.dropped, 0),
      latency_p50_ms_median_over_matches: round(pct(g.map((r) => r.latencyP50Ms ?? NaN).filter(Number.isFinite), 0.5), 1),
      cost_usd_total: round(g.reduce((k, r) => k + r.costUsd, 0), 5),
      models: [...new Set(g.flatMap((r) => r.models))],
      sim_matches_per_hour: decider === "scripted" ? null : round(3600 / mean(wall), 2),
    };
  }
  // paired differences drex - giant per seed
  const paired: Record<string, any> = {};
  for (const timing of ["realtime", "paused"]) {
    const d = new Map(group("drex", timing).map((r) => [r.seed, r.margin]));
    const g = new Map(group("deepinfra", timing).map((r) => [r.seed, r.margin]));
    const diffs = [...d.keys()].filter((s) => g.has(s)).map((s) => d.get(s)! - g.get(s)!);
    if (diffs.length) paired[timing] = { n: diffs.length, mean_drex_minus_giant: round(mean(diffs), 2), ci95: round(ci95(diffs), 2) };
  }
  // thinking-on: a CALCULATION, not a measurement
  const bs = readJson("results", "bench_scenarios.json");
  const thinkP50 = bs?.summary?.deciders?.deepinfra_think?.latency_p50_ms ?? null;
  const gp = conds.deepinfra_paused;
  const thinkCalc =
    thinkP50 && gp
      ? {
          note: "CALCULATION, not a measurement: mean requests per paused giant match x the measured reasoning-on p50 round-trip latency from bench_scenarios (each request's per-robot calls run concurrently, so one request costs about one call's latency)",
          requests_per_match: gp.mean_requests_per_match,
          think_p50_ms: thinkP50,
          estimated_wall_s_per_match: round((gp.mean_requests_per_match * thinkP50) / 1000, 0),
        }
      : null;
  const isMock = ENGINE_IS_STUB || parts.some((p) => p.file.isMock);
  const file = writeResults({
    experiment: "bench_live",
    createdTs: new Date().toISOString(),
    isMock,
    gitCommit: gitCommit(),
    simHash: hashes.join(","),
    config: {
      parts: parts.map((p) => ({ part: p.part, gitCommit: p.file.gitCommit, simHash: p.file.simHash, createdTs: p.file.createdTs, config: p.file.config })),
      giant_reasoning: "off (its fastest setting)",
      blue: "decider via AgentController (batched per tick), red: scripted basic_cycle",
      sim_matches_per_hour: "3600 / mean wall seconds per match, matches played one at a time; the decider drives one alliance (3 robots), the other alliance is scripted",
      simHashesConsistent: hashes.length === 1,
    },
    rows,
    summary: { conditions: conds, paired_drex_minus_giant: paired, giant_reasoning_on_match_estimate: thinkCalc },
  });
  console.log(`[bench:live] assembled ${rows.length} matches -> ${file}`);
  console.log(JSON.stringify({ conds, paired, thinkCalc }, null, 1));
}

if (process.argv.includes("--assemble")) assemble();
else await playPart(arg("part", "drex"), Number(arg("n", "5")), Number(arg("parallel", "1")));
