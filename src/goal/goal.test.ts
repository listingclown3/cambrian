import { describe, expect, it } from "vitest";
import { applyRulesMode, defaultRulesMode, mayMaskIllegal } from "../rules/mode";
import { GoalNotApprovedError, approveGoal, draftGoal, requireApproved } from "./goal";

const metrics = [{ id: "margin", description: "final score margin", direction: "max" as const, unit: "points" }];

describe("goal approval gate", () => {
  it("refuses to start search until a person approves the metrics", () => {
    const g = draftGoal("max points", "rebuilt", metrics);
    expect(() => requireApproved(g)).toThrow(GoalNotApprovedError);
    const ok = approveGoal(g, "Christopher", new Date("2026-11-14T12:00:00Z"));
    expect(() => requireApproved(ok)).not.toThrow();
    expect(ok.approvedTs).toBe("2026-11-14T12:00:00.000Z");
  });

  it("rejects a goal with no metrics, a blank reviewer, or a forged approval", () => {
    expect(() => draftGoal("max points", "rebuilt", [])).toThrow();
    expect(() => approveGoal(draftGoal("x", "rebuilt", metrics), "  ")).toThrow(/reviewer/);
    expect(() => requireApproved({ ...draftGoal("x", "rebuilt", metrics), approved: true })).toThrow(GoalNotApprovedError);
  });
});

describe("rules mode", () => {
  it("defaults to off for game worlds and flag for reality worlds", () => {
    expect(defaultRulesMode("game")).toBe("off");
    expect(defaultRulesMode("reality")).toBe("flag");
  });

  it("keeps everything when off, flags rule breaks, and discards only ILLEGAL when enforcing", () => {
    for (const l of ["LEGAL", "RISKY", "ILLEGAL", "UNJUDGED"] as const) expect(applyRulesMode("off", l)).toBe("keep");
    expect(applyRulesMode("flag", "ILLEGAL")).toBe("keep_flagged");
    expect(applyRulesMode("flag", "LEGAL")).toBe("keep");
    expect(applyRulesMode("enforce", "ILLEGAL")).toBe("discard");
    expect(applyRulesMode("enforce", "RISKY")).toBe("keep_flagged");
    expect(applyRulesMode("enforce", "UNJUDGED")).toBe("keep_flagged");
  });

  it("lets confinement (F2) mask illegal actions only in enforce", () => {
    expect([mayMaskIllegal("off"), mayMaskIllegal("flag"), mayMaskIllegal("enforce")]).toEqual([false, false, true]);
  });
});
