import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRequest } from "../contracts";
import { loadConfig } from "../util/config";
import { anonymizeRequest, anonymizedProvider } from "./anonymize";
import { judgeIncidents } from "./judge";
import { resetSpend } from "./providers/http";
import { drexMockProvider } from "./providers/drexMock";
import { getProvider } from "./registry";
import { fakeDeps } from "./testing";

const cfg = loadConfig();
const dir = mkdtempSync(path.join(tmpdir(), "decide-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetSpend());

const request: DecisionRequest = {
  stateText: "Our hub is active.",
  questions: [
    {
      id: "pick",
      kind: "choice",
      instructions: "Pick one.",
      options: [
        { label: "shoot_now", description: "Shoot now." },
        { label: "collect:neutral", description: "Collect in the neutral zone." },
      ],
    },
  ],
  seed: 1,
  mode: "offline",
};

describe("offline cache", () => {
  it("answers a repeated offline request from disk, flagged cached and not recorded", async () => {
    const deps = fakeDeps({ pick: "collect:neutral" });
    const p = getProvider("drex", cfg, { ...deps, cache: { dir } });
    const first = await p.decide(request);
    expect(first.meta.cached).toBe(false);
    const second = await p.decide({ ...request, seed: 99 });
    expect(second.meta.cached).toBe(true);
    expect(second.answers).toEqual(first.answers);
    expect(second.meta.latencyMs).toBe(first.meta.latencyMs); // the original call's measurement
    expect(deps.requests).toHaveLength(1);
    expect(deps.ledger).toHaveLength(1); // the hit is not in the ledger

    // live requests bypass the cache; a different model is a different key
    await p.decide({ ...request, mode: "live" });
    expect(deps.requests).toHaveLength(2);
    const latest = getProvider("drex", cfg, { ...deps, model: "drex-latest", cache: { dir } });
    expect((await latest.decide(request)).meta.cached).toBe(false);
  });

  it("never stores a fallback", async () => {
    const deps = fakeDeps({}, { status: 500 });
    const p = getProvider("drex", cfg, { ...deps, cache: { dir }, model: "drex-x" });
    expect((await p.decide(request)).meta.fallbackUsed).toBe(true);
    expect((await p.decide(request)).meta.cached).toBe(false);
  });
});

describe("anonymized labels", () => {
  it("shows neutral ids with the same descriptions and maps the answer back", async () => {
    const { request: anon } = anonymizeRequest(request);
    expect(anon.questions[0]!.options).toEqual([
      { label: "opt_01", description: "Shoot now." },
      { label: "opt_02", description: "Collect in the neutral zone." },
    ]);
    expect(anon.stateText).toBe(request.stateText);

    const deps = fakeDeps({ pick: "opt_02" });
    const res = await getProvider("drex", cfg, { ...deps, anonymize: true }).decide(request);
    expect(deps.requests[0]!.body.questions.pick.criteria).toEqual({ opt_01: "Shoot now.", opt_02: "Collect in the neutral zone." });
    expect(res.answers.pick!.chosen).toBe("collect:neutral");
    expect(Object.keys(res.answers.pick!.probabilities!).sort()).toEqual(["collect:neutral", "shoot_now"]);

    const mock = await anonymizedProvider(drexMockProvider).decide(request);
    expect(["shoot_now", "collect:neutral"]).toContain(mock.answers.pick!.chosen);
  });
});

describe("judgeIncidents", () => {
  it("asks one noul question per (incident, rule) pair in one call", async () => {
    const deps = fakeDeps({ violates__i1__G418: 0.9, violates__i2__G418: 0.1 });
    const res = await judgeIncidents(
      getProvider("drex", cfg, deps),
      "Match time 80 s.",
      [
        { id: "i1", description: "R1 pinned B2 against the wall for 4.2 s." },
        { id: "i2", description: "R1 touched B2 for 0.5 s." },
      ],
      [{ id: "G418", text: "A robot may not pin an opponent for more than 3 seconds." }],
    );
    expect(deps.requests).toHaveLength(1);
    expect(Object.keys(deps.requests[0]!.body.questions)).toHaveLength(2);
    expect(deps.requests[0]!.body.state).toContain("G418: A robot may not pin");
    expect(res.judgments).toEqual([
      { incidentId: "i1", ruleId: "G418", pViolation: 0.9, fallbackUsed: false },
      { incidentId: "i2", ruleId: "G418", pViolation: 0.1, fallbackUsed: false },
    ]);
  });
});
