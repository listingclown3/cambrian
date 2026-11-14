import { describe, expect, it } from "vitest";
import { ACTION_NAMES } from "../contracts";
import { loadConfig } from "../util/config";
import { validateProposals } from "./labRun";
import { actionParamText, buildAgentsMd } from "./workspace";

describe("AGENTS.md", () => {
  const cfg = loadConfig();
  it("covers every action and shot spot", () => {
    const text = buildAgentsMd(cfg);
    const params = actionParamText(cfg);
    for (const a of ACTION_NAMES) {
      expect(params[a], a).toBeDefined();
      expect(text).toContain(`- ${a}: params`);
    }
    for (const s of cfg.field.shotSpots.spots) expect(text).toContain(`"${s.id}"`);
    expect(text).toContain("proposals.json");
  });
  it("rejects source urls that are not in notes.json", () => {
    const p = { id: "abc", title: "t", kind: "option_variant", rationale: "r", sourceUrls: ["https://x.test/a"], situation: "s", intent: { action: "hold_position", params: {} } };
    expect(validateProposals({ proposals: [p] }, new Set(["https://x.test/a"])).accepted).toHaveLength(1);
    expect(validateProposals({ proposals: [p] }, new Set(["https://y.test"])).rejected).toHaveLength(1);
  });
});
