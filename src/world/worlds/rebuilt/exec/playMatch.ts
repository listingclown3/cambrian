/**
 * Play one seeded full match headless with scripted policies and log it (owner: P1).
 *
 *   pnpm match                       # seed = first dev seed, policy = archetype-aware default
 *   pnpm match -- --seed 1003 --policy basic_cycle --no-log
 *
 * Writes runs/<runId>/events.jsonl (run_start, decision, engine_event, score, foul, run_end) and
 * prints the final score, ticks, wall time and matches per second.
 */
import { performance } from "node:perf_hooks";
import { intentLabel, type EngineEvent, type Intent, type RobotId, type RunEventBody } from "../../../../contracts";
import { buildActionRequest } from "../../../../search/steer/ask";
import { ENGINE_IS_STUB, buildObservationView, engine } from "../engine";
import { loadConfig } from "../../../../util/config";
import { RunLogger, buildManifest, newRunId } from "../../../../util/runLog";
import { demoRobots } from "./demoMatch";
import { DEFAULT_POLICY_ID, SCRIPTED_POLICIES } from "./policies";
import { robotsNeedingDecision } from "./triggers";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig();
const seed = Number(arg("seed") ?? cfg.seeds.dev[0]);
const policyId = arg("policy") ?? DEFAULT_POLICY_ID;
const policy = SCRIPTED_POLICIES[policyId];
if (!policy) throw new Error(`unknown policy ${policyId}; known: ${Object.keys(SCRIPTED_POLICIES).join(", ")}`);
const log = !process.argv.includes("--no-log");

const runId = newRunId("match");
const matchId = `${runId}-seed${seed}`;
const logger = log ? new RunLogger(runId) : null;
const write = (body: RunEventBody) => logger?.write(body);
const isDev = cfg.seeds.dev.includes(seed);
write({
  type: "run_start",
  isMock: false,
  manifest: buildManifest({
    runId,
    cfg,
    seeds: { dev: isDev ? [seed] : [], eval: cfg.seeds.eval.includes(seed) ? [seed] : [] },
    provider: "scripted",
    model: policy.id,
    isMock: false,
  }),
});

const t0 = performance.now();
let status: "ok" | "error" = "ok";
let error: string | null = null;
let ticks = 0;
let decisions = 0;
let eventCount = 0;
let simMs = 0; // engine + policy time only, excluding log building and file writes
const state = engine.createMatch(cfg, seed, demoRobots(cfg, { blue: policy.id, red: policy.id }));
try {
  let lastEvents: EngineEvent[] = [];
  const since = new Map<RobotId, EngineEvent[]>();
  while (state.phase !== "finished") {
    const intents: Record<RobotId, Intent | undefined> = {};
    for (const robotId of robotsNeedingDecision(state, lastEvents)) {
      const v0 = performance.now();
      const view = buildObservationView(state, robotId, since.get(robotId) ?? []);
      const d0 = performance.now();
      const intent = policy.decide(view);
      const latencyMs = performance.now() - d0;
      simMs += performance.now() - v0;
      intents[robotId] = intent;
      since.set(robotId, []);
      decisions += 1;
      if (logger) {
        write({
          type: "decision",
          isMock: false,
          robotId,
          matchTimeS: state.timeS,
          request: buildActionRequest(view, seed, "offline"),
          meta: { provider: "scripted", model: policy.id, latencyMs, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: null, isMock: false },
          chosenLabel: intentLabel(intent),
          intent,
        });
      }
    }
    const s0 = performance.now();
    const { events } = engine.step(state, intents, state.rules.physics.dtS);
    simMs += performance.now() - s0;
    ticks += 1;
    eventCount += events.length;
    lastEvents = events;
    for (const robot of state.robots) {
      const seen = since.get(robot.id) ?? [];
      seen.push(...events);
      since.set(robot.id, seen.slice(-50));
    }
    if (logger) {
      for (const event of events) {
        write({ type: "engine_event", isMock: false, matchId, event });
        if (event.kind === "score" && event.points !== 0) {
          write({
            type: "score",
            isMock: false,
            matchId,
            matchTimeS: event.timeS,
            alliance: event.alliance,
            points: event.points,
            totals: { red: state.score.red.total, blue: state.score.blue.total },
          });
        }
        if (event.kind === "foul") {
          const foul = state.fouls.findLast((f) => f.byRobotId === event.robotId && f.timeS === event.timeS);
          if (foul) write({ type: "foul", isMock: false, matchId, foul });
        }
      }
    }
  }
} catch (e) {
  status = "error";
  error = e instanceof Error ? e.message : String(e);
}
const wallMs = performance.now() - t0;
write({ type: "run_end", isMock: false, status, durationMs: wallMs, totalCostUsd: 0, error });

const s = state.score;
console.log(`engine:   rebuilt (ENGINE_IS_STUB flag: ${ENGINE_IS_STUB})   seed ${seed}   policy ${policy.id}`);
console.log(`score:    blue ${s.blue.total} (fuel ${s.blue.autoFuel}+${s.blue.teleopFuel}, tower ${s.blue.autoTower}+${s.blue.teleopTower}, fouls ${s.blue.foulPoints})`);
console.log(`          red  ${s.red.total} (fuel ${s.red.autoFuel}+${s.red.teleopFuel}, tower ${s.red.autoTower}+${s.red.teleopTower}, fouls ${s.red.foulPoints})`);
console.log(`ticks:    ${ticks}   decisions ${decisions}   events ${eventCount}   fouls ${state.fouls.length}`);
console.log(`wall:     ${wallMs.toFixed(0)} ms total${log ? " (with logging)" : ""}; simulation ${simMs.toFixed(0)} ms = ${(1000 / simMs).toFixed(2)} matches/s`);
if (logger) console.log(`log:      ${logger.file}`);
if (status === "error") {
  console.error(`error:    ${error}`);
  process.exitCode = 1;
}
