import { describe, expect, it } from "vitest";
import { DecisionRequestSchema, DecisionResponseSchema, IntentSchema, ObservationViewSchema, PROVIDER_IDS, type DecisionRequest } from "../contracts";
import { buildObservationView, engine } from "../engine";
import { MatchRunner, basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { IMPLEMENTED_PROVIDERS, buildActionRequest, chosenIntent, drexMockProvider, getProvider } from "./index";

const cfg = loadConfig();

const request: DecisionRequest = {
  stateText: "test state",
  questions: [
    {
      id: "pick",
      kind: "choice",
      instructions: "Pick one.",
      options: [
        { label: "a", description: "Option a." },
        { label: "b", description: "Option b." },
        { label: "c", description: "Option c." },
      ],
    },
    { id: "yes_no", kind: "noul", instructions: "Is the hub active?" },
    { id: "rate", kind: "score", instructions: "Rate the threat.", levels: ["low", "medium", "high"] },
  ],
  seed: 11,
  mode: "offline",
};

function midMatchView() {
  const runner = new MatchRunner(engine, cfg, 1001, demoRobots(cfg), { default: basicCyclePolicy });
  while (runner.state.timeS < 40) runner.tick();
  return buildObservationView(runner.state, "B1");
}

describe("decision contract", () => {
  it("rejects malformed requests", () => {
    expect(DecisionRequestSchema.safeParse(request).success).toBe(true);
    const noOptions = { ...request, questions: [{ id: "q", kind: "choice", instructions: "Pick." }] };
    const noLevels = { ...request, questions: [{ id: "q", kind: "score", instructions: "Rate." }] };
    expect(DecisionRequestSchema.safeParse(noOptions).success).toBe(false);
    expect(DecisionRequestSchema.safeParse(noLevels).success).toBe(false);
    expect(DecisionRequestSchema.safeParse({ ...request, questions: [] }).success).toBe(false);
  });
});

describe("drex_mock", () => {
  it("returns valid-shaped answers for all three question kinds, tagged isMock", async () => {
    const res = DecisionResponseSchema.parse(await drexMockProvider.decide(request));
    expect(res.meta).toMatchObject({ provider: "drex_mock", isMock: true, fallbackUsed: false, cached: false, error: null, costUsd: 0 });

    const pick = res.answers.pick!;
    expect(["a", "b", "c"]).toContain(pick.chosen);
    expect(Object.keys(pick.probabilities!).sort()).toEqual(["a", "b", "c"]);
    expect(Object.values(pick.probabilities!).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    expect(pick.probabilities![pick.chosen!]).toBe(Math.max(...Object.values(pick.probabilities!)));

    expect(res.answers.yes_no!.probability).toBeGreaterThanOrEqual(0);
    expect(res.answers.yes_no!.probability).toBeLessThanOrEqual(1);
    expect(res.answers.rate!.expectedScore).toBeGreaterThanOrEqual(0);
    expect(res.answers.rate!.expectedScore).toBeLessThanOrEqual(2);
  });

  it("is deterministic per seed and varies across seeds", async () => {
    const a = await drexMockProvider.decide(request);
    const b = await drexMockProvider.decide(request);
    expect(a.answers).toEqual(b.answers);
    const chosen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) chosen.add((await drexMockProvider.decide({ ...request, seed })).answers.pick!.chosen!);
    expect(chosen.size).toBeGreaterThan(1);
  });
});

describe("providers", () => {
  it("every provider id resolves and returns a contract-valid response without throwing", async () => {
    for (const id of PROVIDER_IDS) {
      const res = DecisionResponseSchema.parse(await getProvider(id, cfg).decide(request));
      expect(res.meta.provider).toBe(id);
      expect(Object.keys(res.answers).sort()).toEqual(["pick", "rate", "yes_no"]);
      // unimplemented network providers must say so rather than look like a real answer
      expect(res.meta.fallbackUsed).toBe(!IMPLEMENTED_PROVIDERS.has(id));
      expect(res.meta.error === null).toBe(IMPLEMENTED_PROVIDERS.has(id));
      expect(res.meta.isMock).toBe(id === "drex_mock");
    }
  });
});

describe("view -> request -> intent", () => {
  it("builds a valid action request and maps the answer back to an offered intent", async () => {
    const view = midMatchView();
    expect(() => ObservationViewSchema.parse(view)).not.toThrow();
    const req = DecisionRequestSchema.parse(buildActionRequest(view, 5, "live"));
    expect(req.questions[0]!.options!.map((o) => o.label)).toEqual(view.options.map((o) => o.label));
    const intent = chosenIntent(view.options, await drexMockProvider.decide(req));
    expect(intent).toBeDefined();
    expect(IntentSchema.safeParse(intent).success).toBe(true);
  });

  it("never shows another robot's secret parameters", () => {
    const view = midMatchView();
    const others = JSON.stringify(view.robots);
    for (const secret of ["fireRatePerS", "shotAccuracyByDistance", "capacity", "climbTimeS", "pushForceN", "controllerId", "intent", "then"]) {
      expect(others.includes(`"${secret}"`), secret).toBe(false);
    }
    expect(view.self.profile.fireRatePerS).toBeGreaterThan(0); // a robot does know its own profile
  });
});
