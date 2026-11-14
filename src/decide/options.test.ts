import { describe, expect, it } from "vitest";
import type { ObservationView } from "../contracts";
import { buildObservationView, engine } from "../engine";
import { MatchRunner, basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { buildActionRequest, buildBatchActionRequest } from "./ask";
import { cacheKey } from "./cache";
import { CLIMB_WINDOW_EXTRA_S, PROMPT_VERSION, curateOptions, describeWithFacts, liveOptions } from "./options";

const cfg = loadConfig();
const runner = new MatchRunner(engine, cfg, 1001, demoRobots(cfg), { default: basicCyclePolicy });
const samples: ObservationView[] = [];
for (const t of [5, 25, 40]) {
  while (runner.state.timeS < t) runner.tick();
  for (const r of runner.state.robots) samples.push(buildObservationView(runner.state, r.id));
}
const rules = runner.state.rules;

describe("curateOptions", () => {
  it("is deterministic, never exceeds max, and only returns masked options in masked order", () => {
    for (const v of samples) {
      for (const max of [3, 10]) {
        const a = curateOptions(v, rules, max);
        expect(curateOptions(v, rules, max)).toEqual(a);
        expect(a.length).toBeLessThanOrEqual(max);
        const idx = a.map((o) => v.options.indexOf(o));
        expect(idx.every((i) => i >= 0)).toBe(true);
        expect([...idx].sort((x, y) => x - y)).toEqual(idx);
      }
      if (v.options.length > 10 && v.options.some((o) => o.label === "hold_position")) expect(curateOptions(v, rules).some((o) => o.label === "hold_position")).toBe(true);
    }
  });

  it("filters by type: escape only in contact, climb only in the endgame window, defence only the nearest two", () => {
    for (const v of samples) {
      const c = curateOptions(v, rules);
      if (v.options.length <= 10) continue;
      if (v.self.contact.withRobotId === null) expect(c.some((o) => o.intent.action.startsWith("escape_"))).toBe(false);
      if (v.matchRemainingS > rules.endgameS + CLIMB_WINDOW_EXTRA_S && !v.self.climb.inProgress) expect(c.some((o) => o.intent.action === "climb")).toBe(false);
      expect(c.filter((o) => o.intent.action === "defend").length).toBeLessThanOrEqual(2);
      expect(c.filter((o) => o.intent.action === "goto_shot_spot").length).toBeLessThanOrEqual(2);
    }
    // in the endgame window a climb is kept (when one is offered)
    const late = { ...samples[samples.length - 1]!, matchRemainingS: rules.endgameS };
    if (late.options.some((o) => o.intent.action === "climb") && late.options.length > 10) expect(curateOptions(late, rules).some((o) => o.intent.action === "climb")).toBe(true);
  });
});

describe("describeWithFacts", () => {
  it("keeps the label and the plain description, adds compact facts, and is the same text in every request builder", () => {
    for (const v of samples.slice(-6)) {
      for (const o of curateOptions(v, rules)) {
        const d = describeWithFacts(o, v, rules);
        expect(d.startsWith(o.description)).toBe(true);
        expect(d.length).toBeLessThan(o.description.length + 120);
      }
      const shoot = v.options.find((o) => o.intent.action === "shoot_now" || o.intent.action === "align_then_shoot");
      if (shoot) expect(describeWithFacts(shoot, v, rules)).toMatch(/~\d+ pts, ~[\d.]+ s/);
      const single = buildActionRequest(v, 1, "live", { rules }).questions[0]!.options;
      const batch = buildBatchActionRequest([v], 1, "live", {}, { rules }).questions[0]!.options;
      expect(single).toEqual(liveOptions(v, rules));
      expect(batch).toEqual(single);
    }
  });

  it("puts the prompt version in the cache key", () => {
    const req = { stateText: "s", questions: [{ id: "q", kind: "noul" as const, instructions: "?" }] };
    expect(PROMPT_VERSION).toMatch(/^p2-/);
    expect(cacheKey("drex", "m", "", req)).not.toBe(cacheKey("drex", "m", "", { ...req, stateText: "t" }));
  });
});
