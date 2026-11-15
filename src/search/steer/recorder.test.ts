import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunEventSchema, type DecisionProvider, type Intent, type RunEvent } from "../../contracts";
import { engine } from "../../world/worlds/rebuilt/engine";
import { basicCyclePolicy, demoRobots } from "../../world/worlds/rebuilt/exec";
import { loadConfig } from "../../util/config";
import { AgentController } from "./controller";
import { drexMockProvider } from "../../providers/drexMock";
import { MatchRecorder } from "./recorder";

const cfg = loadConfig();
const UNTIL_S = 60;
const dir = mkdtempSync(path.join(tmpdir(), "recorder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const slowMock: DecisionProvider = {
  id: "drex_mock",
  async decide(req) {
    const res = await drexMockProvider.decide(req);
    return { ...res, meta: { ...res.meta, latencyMs: 730 } };
  },
};

/** Re-simulate a log the way the server's /ws/replay does (to match time untilS). */
function replay(events: RunEvent[], untilS = Infinity) {
  const start = events.find((e) => e.type === "run_start")!;
  if (start.type !== "run_start") throw new Error("no run_start");
  const seed = start.manifest.seeds.eval[0] ?? start.manifest.seeds.dev[0] ?? 1;
  const decisions = events.flatMap((e) => (e.type === "decision" && e.intent ? [{ robotId: e.robotId, timeS: e.matchTimeS, intent: e.intent }] : []));
  const state = engine.createMatch(cfg, seed, demoRobots(cfg));
  let next = 0;
  while (state.phase !== "finished" && state.timeS < untilS - 1e-9) {
    const intents: Record<string, Intent> = {};
    while (next < decisions.length && decisions[next]!.timeS <= state.timeS + 1e-9) {
      const d = decisions[next++]!;
      intents[d.robotId] = d.intent;
    }
    engine.step(state, intents, cfg.physics.dtS);
  }
  return state;
}

describe("MatchRecorder", () => {
  it("writes a contract-valid log that replays to the same match (realtime, captain on)", async () => {
    const seed = cfg.seeds.eval[0]!;
    const rec = new MatchRecorder(cfg, seed, "t-match");
    const summary = await new AgentController({
      engine,
      cfg,
      seed,
      robots: demoRobots(cfg),
      agents: { blue: { provider: slowMock, captain: true } },
      scripted: { default: basicCyclePolicy },
      timing: "realtime",
      ...rec.hooks(),
    }).run(UNTIL_S);
    const { file, lines } = rec.write({ runId: "t-run", provider: "drex_mock", status: "ok", durationMs: summary.wallMs, error: null, dir });

    const parsed = readFileSync(file, "utf8").trim().split("\n").map((l) => RunEventSchema.parse(JSON.parse(l)));
    expect(parsed).toHaveLength(lines.length);
    expect(parsed[0]!.type).toBe("run_start");
    expect(parsed.at(-1)!.type).toBe("run_end");
    parsed.forEach((e, i) => expect(e.seq).toBe(i));
    const start = parsed[0]!;
    if (start.type !== "run_start") throw new Error();
    expect(start.manifest).toMatchObject({ provider: "drex_mock", model: "drex-mock", isMock: true, seeds: { dev: [], eval: [seed] } });

    // decision lines: applied time, not request time; raw JSON keeps request time and probabilities
    const raw = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const agentLines = raw.filter((l) => l.type === "decision" && l.meta.provider === "drex_mock" && l.decisionKind === "intent" && l.intent);
    expect(agentLines.length).toBeGreaterThan(5);
    for (const l of agentLines) {
      expect(l.matchTimeS).toBeCloseTo(l.appliedAtS, 12);
      expect(l.matchTimeS - l.requestedAtS).toBeGreaterThanOrEqual(0.73 - 1e-9);
      expect(Object.values(l.probabilities as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    expect(raw.some((l) => l.type === "decision" && l.meta.provider === "scripted")).toBe(true);

    const replayed = replay(parsed, UNTIL_S);
    expect(replayed.timeS).toBeCloseTo(summary.state.timeS, 9);
    expect(replayed.score.blue!.total).toBe(summary.state.score.blue!.total);
    expect(replayed.score.red!.total).toBe(summary.state.score.red!.total);
  });
});
