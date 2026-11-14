import { describe, expect, it } from "vitest";
import type { DecisionProvider, DecisionRequest, DecisionResponse, Engine, EngineEvent } from "../contracts";
import { engine } from "../engine";
import { basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { AgentController, type ControllerDecision } from "./controller";
import { localMeta } from "./providers/shared";

const cfg = loadConfig();
const T = cfg.triggers as typeof cfg.triggers & { minCommitS: number; coalesceS: number; maxIdleS: number };

/**
 * The real engine, but its own events are replaced by a script, so the only triggers are the
 * injected ones (and idle robots): event `e` is emitted on the first tick ending at or after e.t.
 */
function scripted(script: { t: number; e: Record<string, unknown> }[]): Engine {
  const left = [...script];
  return {
    ...engine,
    step(state, intents, dtS) {
      const res = engine.step(state, intents, dtS);
      const fire: EngineEvent[] = [];
      while (left.length && left[0]!.t <= state.timeS + 1e-9) fire.push({ timeS: state.timeS, ...left.shift()!.e } as unknown as EngineEvent);
      return { state: res.state, events: fire };
    },
  };
}

/** Always answers hold_position (a continuous action: it never finishes on its own). */
function holder(latencyMs = 0, requests: DecisionRequest[] = []): DecisionProvider {
  return {
    id: "drex_mock",
    async decide(req): Promise<DecisionResponse> {
      requests.push(req);
      const answers = Object.fromEntries(req.questions.map((q) => [q.id, { chosen: q.options!.find((o) => o.label === "hold_position")?.label ?? q.options![0]!.label, probabilities: null }]));
      return { answers, meta: { ...localMeta("drex_mock", "holder", performance.now(), { isMock: true }), latencyMs } };
    },
  };
}

const robotTimes = (ds: ControllerDecision[], id: string) => ds.filter((d) => d.kind === "intent" && d.choices.some((c) => c.robotId === id)).map((d) => d.requestedAtS);

describe("commitment rule", () => {
  it("ignores non-critical triggers during the hold, honours them after it, and breaks the hold on a critical one", async () => {
    expect(T.minCommitS).toBeGreaterThan(1);
    const script = [
      { t: 1.0, e: { kind: "opponent_in_range", robotId: "B1", opponentId: "R1", distanceM: 1 } }, // inside the hold: ignored
      { t: 3.0, e: { kind: "opponent_in_range", robotId: "B1", opponentId: "R1", distanceM: 1 } }, // after the hold: asked
      { t: 3.6, e: { kind: "hopper_full", robotId: "B1" } }, // critical inside the new hold: asked
    ];
    const requests: DecisionRequest[] = [];
    const c = new AgentController({ engine: scripted(script), cfg, seed: 1001, robots: demoRobots(cfg), agents: { blue: { provider: holder(0, requests) } }, scripted: { default: basicCyclePolicy } });
    await c.run(6);
    const b1 = robotTimes(c.decisions, "B1");
    expect(b1).toHaveLength(3);
    expect(b1[0]).toBeCloseTo(T.coalesceS, 6); // match start, after the coalescing window
    expect(b1[1]!).toBeGreaterThanOrEqual(3.0);
    expect(b1[1]!).toBeLessThan(3.0 + T.coalesceS + 0.15);
    expect(b1[2]! - b1[1]!).toBeLessThan(T.minCommitS); // the critical trigger broke the hold
    expect(b1[2]!).toBeGreaterThanOrEqual(3.6);
    expect(c.decisions[0]!.requests[0]!.questions).toHaveLength(3); // all three robots, one call
  });

  it("coalesces triggers that arrive within coalesceS into one decision moment and one call", async () => {
    const script = [
      { t: 6.0, e: { kind: "opponent_in_range", robotId: "B2", opponentId: "R1", distanceM: 1 } },
      { t: 6.0 + T.coalesceS * 0.6, e: { kind: "opponent_in_range", robotId: "B3", opponentId: "R1", distanceM: 1 } },
    ];
    const requests: DecisionRequest[] = [];
    const c = new AgentController({ engine: scripted(script), cfg, seed: 1001, robots: demoRobots(cfg), agents: { blue: { provider: holder(0, requests) } }, scripted: { default: basicCyclePolicy } });
    await c.run(8);
    const late = requests.filter((r) => r.questions.some((q) => q.id.endsWith("B2") || q.id.endsWith("B3"))).slice(1);
    expect(late).toHaveLength(1);
    expect(late[0]!.questions.map((q) => q.id).sort()).toEqual(["next_action_B2", "next_action_B3"]);
  });

  it("can be turned off: then every trigger re-asks at once", async () => {
    const script = [{ t: 1.0, e: { kind: "opponent_in_range", robotId: "B1", opponentId: "R1", distanceM: 1 } }];
    const c = new AgentController({ engine: scripted(script), cfg, seed: 1001, robots: demoRobots(cfg), agents: { blue: { provider: holder() } }, scripted: { default: basicCyclePolicy }, fairness: { commitment: false } });
    await c.run(3);
    const b1 = robotTimes(c.decisions, "B1");
    expect(b1).toHaveLength(2);
    expect(b1[0]).toBe(0);
    expect(b1[1]!).toBeLessThan(1.0 + 0.11);
  });
});

describe("no-idle rule", () => {
  it("gives a waiting robot roleContinuation after maxIdleS and lets the answer replace it", async () => {
    const continuations: { robotId: string; timeS: number }[] = [];
    const c = new AgentController({
      engine: scripted([]),
      cfg,
      seed: 1001,
      robots: demoRobots(cfg),
      agents: { blue: { provider: holder(3000) } },
      scripted: { default: basicCyclePolicy },
      timing: "realtime",
      onContinuation: (d) => continuations.push(d),
    });
    const s = await c.run(5);
    const b1 = continuations.filter((x) => x.robotId === "B1");
    expect(b1).toHaveLength(1);
    expect(b1[0]!.timeS).toBeCloseTo(T.maxIdleS, 6);
    expect(s.byRobot.B1!.idleS).toBeCloseTo(T.maxIdleS, 1); // never idle while waiting beyond maxIdleS
    expect(s.byRobot.B1!.continuationS).toBeGreaterThan(2); // driven by the continuation until the answer
    const answered = s.decisions.find((d) => d.kind === "intent" && d.choices.some((ch) => ch.robotId === "B1"))!;
    expect(answered.appliedAtS!).toBeCloseTo(T.coalesceS + 3, 6);
    expect(s.byAlliance.blue.robotDecisions).toBe(s.decisions.reduce((n, d) => n + d.choices.length, 0)); // continuations are not decisions
    expect(s.byAlliance.blue.continuations).toBe(3);
    expect(s.byAlliance.blue.interruptedActions).toBe(0); // replacing a continuation is not an interruption
  });
});

describe("anti-loop guard", () => {
  /** Real engine (only its action-end events kept); B1's hold_position fails the tick it is applied. */
  function failing(): Engine {
    return {
      ...engine,
      step(state, intents, dtS) {
        const res = engine.step(state, intents, dtS);
        const b1 = state.robots.find((r) => r.id === "B1")!;
        if (b1.intent?.action === "hold_position") {
          b1.intent = null;
          return { state: res.state, events: [{ kind: "action_failed", timeS: state.timeS, robotId: "B1", action: "hold_position", reason: "test_fail" } as EngineEvent] };
        }
        // keep the real engine's action ends, so options that finish at once are caught too
        return { state: res.state, events: res.events.filter((e) => e.kind === "action_done" || e.kind === "action_failed" || e.kind === "action_timeout") };
      },
    };
  }
  const run = async (antiLoop: boolean) => {
    const requests: DecisionRequest[] = [];
    const c = new AgentController({ engine: failing(), cfg, seed: 1001, robots: demoRobots(cfg), agents: { blue: { provider: holder(0, requests) } }, scripted: { default: basicCyclePolicy }, fairness: { antiLoop } });
    const s = await c.run(10);
    return { s, requests, b1: robotTimes(c.decisions, "B1").length };
  };

  it("withholds an instantly failing option, says why, and keeps decisions bounded", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(off.b1).toBeGreaterThan(20); // re-asked after every instant failure
    expect(on.b1).toBeLessThanOrEqual(6);
    expect(on.s.byRobot.B1!.fastFails).toBeGreaterThanOrEqual(1);
    expect(on.s.byAlliance.blue.cooledDown).toBe(on.s.byRobot.B1!.cooledDown + on.s.byRobot.B2!.cooledDown + on.s.byRobot.B3!.cooledDown);
    const noted = on.requests.find((r) => r.questions.some((q) => q.instructions.includes("Last action hold_position failed immediately: test_fail.")));
    expect(noted).toBeDefined();
    const q = noted!.questions.find((x) => x.id === "next_action_B1")!;
    expect(q.options!.some((o) => o.label === "hold_position")).toBe(false); // on cool-down
  });
});
