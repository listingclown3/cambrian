/**
 * Writes src/server/fixtures/showcase_fixture/events.jsonl (owner: P4): one match on the STUB
 * engine with the scripted basic_cycle controller, logged in the run-log format. Everything in it
 * is isMock = true. `pnpm record:fixture` regenerates it; the replay endpoint re-simulates the
 * match from the seed and the logged intents.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { stepLabel, type RunEventBody, type RunEvent } from "../contracts";
import { engine } from "../engine";
import { buildObservationView } from "../engine/observe";
import { robotsNeedingDecision, basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig, repoPath } from "../util/config";

const cfg = loadConfig();
const seed = 2026;
const runId = "showcase_fixture";
const state = engine.createMatch(cfg, seed, demoRobots(cfg));
const lines: RunEvent[] = [];
let seq = 0;
const ts = "2026-11-14T00:00:00.000Z";
const push = (body: RunEventBody) => lines.push({ ts, runId, seq: seq++, ...body } as RunEvent);

push({
  type: "run_start",
  isMock: true,
  manifest: { runId, gitCommit: "fixture", simHash: "fixture", config: cfg, seeds: { dev: [seed], eval: [] }, provider: "scripted", model: "basic_cycle", isMock: true, startedTs: ts },
});
let last: ReturnType<typeof engine.step>["events"] = [];
const since = new Map<string, typeof last>();
while (state.phase !== "finished") {
  const intents: Record<string, import("../contracts").Intent> = {};
  for (const id of robotsNeedingDecision(state, last)) {
    const view = buildObservationView(state, id, since.get(id) ?? []);
    const intent = basicCyclePolicy.decide(view);
    since.set(id, []);
    intents[id] = intent;
    push({
      type: "decision",
      isMock: true,
      robotId: id,
      matchTimeS: state.timeS,
      request: { stateText: "(scripted policy; no text rendered)", questions: [{ id: "action", kind: "choice", instructions: "pick an action", options: view.options.map((o) => ({ label: o.label, description: o.description })) }], seed, mode: "live" },
      meta: { provider: "scripted", model: "basic_cycle", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: null, isMock: true },
      chosenLabel: stepLabel(intent),
      intent,
    });
  }
  last = engine.step(state, intents, state.rules.physics.dtS).events;
  for (const r of state.robots) since.set(r.id, [...(since.get(r.id) ?? []), ...last].slice(-50));
}
push({ type: "run_end", isMock: true, status: "ok", durationMs: 0, totalCostUsd: 0, error: null });
const dir = repoPath("src", "server", "fixtures", runId);
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/events.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(`wrote ${lines.length} lines to ${dir}/events.jsonl; final ${state.score.blue.total}-${state.score.red.total}`);
