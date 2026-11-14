import { describe, expect, it } from "vitest";
import { DecisionRequestSchema, IntentSchema, RunEventSchema, type DecisionProvider, type DecisionRequest, type DecisionResponse } from "../contracts";
import { engine } from "../engine";
import { basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { AgentController, decisionRunEvents, type ControllerDecision } from "./controller";
import { drexMockProvider } from "./providers/drexMock";
import { fallbackResponse } from "./providers/shared";

const cfg = loadConfig();
const dt = cfg.physics.dtS;

/** drex_mock answers, but reporting a fixed, known latency. */
function fixedLatency(latencyMs: number, calls: DecisionRequest[] = []): DecisionProvider {
  return {
    id: "drex_mock",
    async decide(req): Promise<DecisionResponse> {
      calls.push(req);
      const res = await drexMockProvider.decide(req);
      return { ...res, meta: { ...res.meta, latencyMs } };
    },
  };
}

function controller(provider: DecisionProvider, extra: Partial<ConstructorParameters<typeof AgentController>[0]> = {}) {
  return new AgentController({ engine, cfg, seed: 1001, robots: demoRobots(cfg), agents: { blue: { provider, captain: true } }, scripted: { default: basicCyclePolicy }, ...extra });
}

const intentDecisions = (ds: ControllerDecision[]) => ds.filter((d) => d.kind === "intent");

describe("AgentController (paused)", () => {
  it("plays a full match with drex_mock, batching robots and assigning captain roles", async () => {
    const calls: DecisionRequest[] = [];
    const summary = await controller(fixedLatency(500, calls)).run();
    expect(summary.state.phase).toBe("finished");
    expect(summary.calls.blue).toBe(calls.length);
    expect(summary.calls.red).toBe(0); // red is scripted
    for (const req of calls) expect(DecisionRequestSchema.safeParse(req).success).toBe(true);

    const intents = intentDecisions(summary.decisions);
    expect(intents.length).toBeGreaterThan(3);
    // match start: all three idle blue robots in one request
    expect(intents[0]!.requests[0]!.questions).toHaveLength(3);
    for (const d of intents) {
      expect(d.alliance).toBe("blue");
      expect(d.chargedS).toBe(0);
      expect(d.appliedAtS).toBe(d.requestedAtS); // paused: the match waited
      const req = d.requests[0]!;
      for (const c of d.choices) {
        expect(c.usedFallbackPolicy).toBe(false);
        const q = req.questions.find((q) => q.id === `next_action_${c.robotId}`)!;
        expect(q.options!.map((o) => o.label)).toContain(c.chosenLabel);
        expect(IntentSchema.safeParse(c.intent).success).toBe(true);
      }
      // no robot's private profile in the shared state text
      expect(req.stateText).not.toMatch(/holds up to|shot range/);
    }

    const captains = summary.decisions.filter((d) => d.kind === "captain");
    expect(captains.length).toBeGreaterThanOrEqual(2); // match start + at least one hub shift
    for (const d of captains) {
      expect(d.requests).toHaveLength(3); // sequential: one question per robot
      expect(d.choices.every((c) => c.role !== undefined)).toBe(true);
      expect(d.requests[2]!.questions[0]!.instructions).toMatch(/Already assigned: B1 .*, B2 /);
    }
    // every decision becomes contract-valid run-log lines, one per robot
    for (const d of summary.decisions.slice(0, 20)) {
      const lines = decisionRunEvents(d);
      expect(lines).toHaveLength(d.choices.length);
      for (const l of lines) expect(RunEventSchema.safeParse({ ...l, ts: "t", runId: "r", seq: 0 }).success).toBe(true);
    }
    // a role reaches the robot's own question
    expect(intents.some((d) => d.requests[0]!.questions.some((q) => q.instructions.includes("Captain's role for")))).toBe(true);
  });

  it("drives the robot with the fallback policy when the provider fails, and says so", async () => {
    const failing: DecisionProvider = { id: "drex", decide: async (req) => fallbackResponse(req, "drex", "drex-v2.0", performance.now(), "boom") };
    const c = controller(failing, { agents: { blue: { provider: failing } } });
    for (let i = 0; i < 5; i++) await c.tick();
    const first = intentDecisions(c.decisions)[0]!;
    expect(first.metas[0]!.fallbackUsed).toBe(true);
    expect(first.choices.every((ch) => ch.usedFallbackPolicy && ch.intent !== null)).toBe(true);
  });
});

describe("AgentController (realtime latency charging)", () => {
  for (const [latencyMs, scale] of [
    [730, 1],
    [730, 2],
    [40, 1],
    [1, 1],
  ] as const) {
    it(`applies each answer exactly latency x scale later (${latencyMs} ms x ${scale})`, async () => {
      const summary = await controller(fixedLatency(latencyMs), { timing: "realtime", latencyScale: scale }).run();
      const charged = (latencyMs * scale) / 1000;
      const ticksLate = Math.ceil(charged / dt - 1e-9);
      const applied = summary.decisions.filter((d) => d.appliedAtS !== null);
      expect(applied.length).toBeGreaterThan(3);
      for (const d of summary.decisions) {
        expect(d.chargedS).toBeCloseTo(d.kind === "captain" ? (3 * latencyMs * scale) / 1000 : charged, 12);
        if (d.appliedAtS === null) continue;
        const delay = d.appliedAtS - d.requestedAtS;
        // Applied at the first tick start at or after requestedAt + charged: never early, < one tick late.
        expect(delay).toBeGreaterThanOrEqual(d.chargedS - 1e-9);
        expect(delay).toBeLessThan(d.chargedS + dt - 1e-9);
        if (d.kind === "intent") expect(Math.round(delay / dt)).toBe(ticksLate);
      }
      // A robot is never asked again while its previous answer is outstanding.
      const byRobot = new Map<string, ControllerDecision[]>();
      for (const d of intentDecisions(summary.decisions)) for (const c of d.choices) byRobot.set(c.robotId, [...(byRobot.get(c.robotId) ?? []), d]);
      for (const ds of byRobot.values()) {
        const sorted = [...ds].sort((a, b) => a.requestedAtS - b.requestedAtS);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.requestedAtS).toBeGreaterThanOrEqual((sorted[i - 1]!.appliedAtS ?? Infinity) - 1e-9);
      }
      expect(summary.chargedS.blue).toBeCloseTo(summary.decisions.reduce((s, d) => s + d.chargedS, 0), 9);
      expect(summary.dropped).toBe(summary.decisions.filter((d) => d.appliedAtS === null).length);
    });
  }

  it("charges nothing in paused mode even for a slow provider, and slow answers change the match in realtime", async () => {
    const paused = await controller(fixedLatency(5000)).run();
    expect(paused.chargedS.blue).toBe(0);
    const slow = await controller(fixedLatency(5000), { timing: "realtime" }).run();
    expect(slow.chargedS.blue).toBeGreaterThan(0);
    expect(intentDecisions(slow.decisions).length).toBeLessThan(intentDecisions(paused.decisions).length);
  });
});
