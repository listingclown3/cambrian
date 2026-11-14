/**
 * pnpm matches [-- --per-seed 4] (owner: P3)
 * Play scripted-policy (basic_cycle) matches between league line-ups on DEV seeds. Each match is
 * logged to runs/<runId>-m<k>/events.jsonl (run_start, decision, engine_event, run_end). The
 * line-ups are deterministic from (seed, k), so `pnpm mine` can replay any match exactly.
 * matches_per_sec counts engine + policy time only (log building and writes excluded), measured
 * in one process on one core.
 *
 * Writes results/matches.json.
 */
import { performance } from "node:perf_hooks";
import { intentLabel, type EngineEvent, type Intent, type RobotId } from "../contracts";
import { buildActionRequest } from "../decide/ask";
import { ENGINE_IS_STUB, buildObservationView, engine } from "../engine";
import { basicCyclePolicy, robotsNeedingDecision } from "../exec";
import { loadConfig } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { RunLogger, buildManifest, newRunId, writeResults } from "../util/runLog";
import { drawLineup, lineupKey, loadLeague, mean, round } from "./common";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const cfg = loadConfig();
const league = loadLeague();
const perSeed = Number(arg("per-seed", "4"));
const baseRunId = newRunId("matches");
const policy = basicCyclePolicy;

const rows: Record<string, unknown>[] = [];
let totalSimMs = 0;
for (const seed of cfg.seeds.dev) {
  for (let k = 0; k < perSeed; k++) {
    const runId = `${baseRunId}-s${seed}-m${k}`;
    const matchId = runId;
    const logger = new RunLogger(runId);
    const robots = drawLineup(league, lineupKey(seed, k));
    logger.write({ type: "run_start", isMock: false, manifest: buildManifest({ runId, cfg, seeds: { dev: [seed], eval: [] }, provider: "scripted", model: policy.id, isMock: false }) });
    const t0 = performance.now();
    let simMs = 0;
    let decisions = 0;
    const state = engine.createMatch(cfg, seed, robots);
    let lastEvents: EngineEvent[] = [];
    const since = new Map<RobotId, EngineEvent[]>();
    while (state.phase !== "finished") {
      const intents: Record<RobotId, Intent | undefined> = {};
      for (const robotId of robotsNeedingDecision(state, lastEvents)) {
        const v0 = performance.now();
        const view = buildObservationView(state, robotId, since.get(robotId) ?? []);
        const intent = policy.decide(view);
        simMs += performance.now() - v0;
        intents[robotId] = intent;
        since.set(robotId, []);
        decisions += 1;
        logger.write({
          type: "decision",
          isMock: false,
          robotId,
          matchTimeS: state.timeS,
          request: { ...buildActionRequest(view, seed, "offline"), stateText: "(omitted in match logs; replay the seed to rebuild it)" },
          meta: { provider: "scripted", model: policy.id, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: null, isMock: false },
          chosenLabel: intentLabel(intent),
          intent,
        });
      }
      const s0 = performance.now();
      const { events } = engine.step(state, intents, state.rules.physics.dtS);
      simMs += performance.now() - s0;
      lastEvents = events;
      for (const robot of state.robots) {
        const seen = since.get(robot.id) ?? [];
        seen.push(...events);
        since.set(robot.id, seen.slice(-50));
      }
      for (const event of events) if (event.kind !== "score") logger.write({ type: "engine_event", isMock: false, matchId, event });
    }
    logger.write({ type: "run_end", isMock: false, status: "ok", durationMs: performance.now() - t0, totalCostUsd: 0, error: null });
    totalSimMs += simMs;
    rows.push({
      matchId,
      seed,
      lineupIndex: k,
      log: `runs/${runId}/events.jsonl`,
      blue: robots.filter((r) => r.alliance === "blue").map((r) => r.profile.id),
      red: robots.filter((r) => r.alliance === "red").map((r) => r.profile.id),
      scoreBlue: state.score.blue.total,
      scoreRed: state.score.red.total,
      decisions,
      fouls: state.fouls.length,
      simMs: round(simMs, 1),
    });
    console.log(`[matches] seed ${seed} m${k}: blue ${state.score.blue.total} - red ${state.score.red.total}, ${decisions} decisions, ${simMs.toFixed(0)} ms sim`);
  }
}

const matchesPerSec = rows.length / (totalSimMs / 1000);
const file = writeResults({
  experiment: "matches",
  createdTs: new Date().toISOString(),
  isMock: ENGINE_IS_STUB,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { seeds: { dev: cfg.seeds.dev, eval: [] }, perSeed, policy: policy.id, league: "data/league/league.json", runPrefix: baseRunId },
  rows,
  summary: {
    n_matches: rows.length,
    seeds: cfg.seeds.dev,
    matches_per_sec: round(matchesPerSec, 3),
    matches_per_sec_note: "engine + scripted policy time only, single process, one core; log writing excluded",
    mean_decisions_per_match: round(mean(rows.map((r) => r.decisions as number)), 1),
    mean_score_blue: round(mean(rows.map((r) => r.scoreBlue as number)), 2),
    mean_score_red: round(mean(rows.map((r) => r.scoreRed as number)), 2),
    engine_is_stub: ENGINE_IS_STUB,
  },
});
console.log(`[matches] ${rows.length} matches, ${matchesPerSec.toFixed(2)} matches/s (sim only) -> ${file}`);
