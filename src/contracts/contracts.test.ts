import { describe, expect, it } from "vitest";
import { engine } from "../engine";
import { demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import {
  ACTION_NAMES,
  ALLOWED_PAIRS,
  ARCHETYPES,
  CAPTAIN_ROLE_NAMES,
  CaptainRoleSchema,
  EngineEventSchema,
  HEADLINE_KEYS,
  HeadlineSchema,
  IntentSchema,
  PROVIDER_IDS,
  RunEventSchema,
  emptyHeadline,
  getRobot,
  maskOptions,
  maskThenOptions,
  profileFromTemplate,
  withThen,
  type MatchState,
  type RobotState,
} from "./index";

const cfg = loadConfig();

/** A fresh demo match plus a helper to fetch one robot and its option labels. */
function setup(): { state: MatchState; robot: (id: string) => RobotState; labels: (id: string) => string[] } {
  const state = engine.createMatch(cfg, 1, demoRobots(cfg));
  return {
    state,
    robot: (id) => getRobot(state, id),
    labels: (id) => maskOptions(getRobot(state, id), state).map((o) => o.label),
  };
}
const hasAction = (labels: string[], action: string) => labels.some((l) => l === action || l.startsWith(`${action}:`));

describe("actions: master list", () => {
  it("has exactly the confirmed action names", () => {
    expect([...ACTION_NAMES].sort()).toEqual(
      [
        "goto_zone", "goto_shot_spot", "route_via", "hold_position",
        "collect", "load_outpost", "steal_fuel",
        "shoot_now", "align_then_shoot", "dump_unaligned", "shoot_on_move", "hold_fire_until_active", "stage_fuel", "pass_to",
        "defend", "block_lane", "screen", "push_through", "escape_spin", "escape_reverse", "disengage",
        "climb", "protect_climber", "abort_climb",
      ].sort(),
    );
  });

  it("has exactly the confirmed allowed pairs", () => {
    const afterEscape = ["defend", "stage_fuel", "collect", "goto_shot_spot"];
    expect(ALLOWED_PAIRS).toEqual({
      escape_spin: afterEscape,
      escape_reverse: afterEscape,
      disengage: afterEscape,
      pass_to: ["defend", "collect", "screen"],
      collect: ["stage_fuel", "hold_fire_until_active", "goto_shot_spot"],
      shoot_on_move: ["climb", "defend", "collect"],
      shoot_now: ["climb", "defend", "collect"],
    });
  });

  it("accepts valid intents and rejects invalid ones", () => {
    expect(IntentSchema.safeParse({ action: "goto_zone", params: { zone: "neutral" } }).success).toBe(true);
    expect(IntentSchema.safeParse({ action: "climb", params: { level: 3 } }).success).toBe(true);
    expect(IntentSchema.safeParse({ action: "climb", params: { level: 4 } }).success).toBe(false);
    expect(IntentSchema.safeParse({ action: "goto_zone", params: { zone: "moon" } }).success).toBe(false);
    expect(IntentSchema.safeParse({ action: "teleport", params: {} }).success).toBe(false);
    // shoot_on_move and pass_to take exactly one of their two parameters
    expect(IntentSchema.safeParse({ action: "shoot_on_move", params: { path: "left_bump" } }).success).toBe(true);
    expect(IntentSchema.safeParse({ action: "shoot_on_move", params: { path: "left_bump", spotId: "hub_close" } }).success).toBe(false);
    expect(IntentSchema.safeParse({ action: "pass_to", params: {} }).success).toBe(false);
  });

  it("enforces ALLOWED_PAIRS on `then`", () => {
    const ok = { action: "collect", params: { source: "neutral" }, then: { action: "goto_shot_spot", params: { spotId: "hub_close" } } };
    const bad = { action: "collect", params: { source: "neutral" }, then: { action: "climb", params: { level: 1 } } };
    const noPairs = { action: "hold_position", params: {}, then: { action: "collect", params: { source: "neutral" } } };
    expect(IntentSchema.safeParse(ok).success).toBe(true);
    expect(IntentSchema.safeParse(bad).success).toBe(false);
    expect(IntentSchema.safeParse(noPairs).success).toBe(false);
  });

  it("has the six captain roles, with a target only on defender", () => {
    expect([...CAPTAIN_ROLE_NAMES]).toEqual(["scorer", "feeder", "stager", "collector", "defender", "climber"]);
    expect(CaptainRoleSchema.safeParse({ role: "defender", target: "R1" }).success).toBe(true);
    expect(CaptainRoleSchema.safeParse({ role: "defender" }).success).toBe(false);
    expect(CaptainRoleSchema.safeParse({ role: "scorer" }).success).toBe(true);
  });
});

describe("actions: maskOptions", () => {
  it("gives every option a unique label, a one-sentence description and a valid intent", () => {
    const { state } = setup();
    for (const robot of state.robots) {
      const options = maskOptions(robot, state);
      expect(options.length).toBeGreaterThan(5);
      expect(options.length).toBeLessThanOrEqual(255); // Drex limit on options per question
      expect(new Set(options.map((o) => o.label)).size).toBe(options.length);
      for (const o of options) {
        expect(o.description).toMatch(/^[A-Z][^.!?]*\.$/);
        expect(IntentSchema.safeParse(o.intent).success).toBe(true);
      }
    }
  });

  it("no fuel -> no shoot, pass or stage", () => {
    const { robot, labels } = setup();
    robot("B1").fuelHeld = 0;
    for (const action of ["shoot_now", "align_then_shoot", "dump_unaligned", "shoot_on_move", "stage_fuel", "pass_to"]) {
      expect(hasAction(labels("B1"), action), action).toBe(false);
    }
    robot("B1").fuelHeld = 5;
    expect(hasAction(labels("B1"), "stage_fuel")).toBe(true);
  });

  it("not shootOnMove -> no shoot_on_move", () => {
    const { robot, labels } = setup();
    expect(robot("B1").profile.shootOnMove).toBe(true); // turret_sotm
    expect(hasAction(labels("B1"), "shoot_on_move")).toBe(true);
    expect(robot("B2").profile.shootOnMove).toBe(false); // drum_fixed
    expect(hasAction(labels("B2"), "shoot_on_move")).toBe(false);
  });

  it("!fitsUnderTrench -> no trench routes", () => {
    const { robot, labels } = setup();
    robot("B1").profile.fitsUnderTrench = false;
    const without = labels("B1");
    expect(without).toContain("route_via:left_bump");
    expect(without.filter((l) => l.includes("trench") && !l.startsWith("goto"))).toEqual([]);
    robot("B1").profile.fitsUnderTrench = true;
    const withTrench = labels("B1");
    expect(withTrench).toContain("route_via:left_trench");
    expect(withTrench).toContain("shoot_on_move:path=right_trench");
  });

  it("dumper not adjacent to the hub -> no shoot_now, goto_shot_spot offered instead", () => {
    const { state, robot, labels } = setup();
    const dumper = robot("R2");
    expect(dumper.profile.archetype).toBe("dumper");
    dumper.alignment.aligned = true;
    const far = labels("R2");
    expect(far).not.toContain("shoot_now");
    expect(far).not.toContain("align_then_shoot");
    expect(far).toContain("goto_shot_spot:hub_close");
    const spot = state.field.shotSpots.find((s) => s.alliance === "red" && s.id === "hub_close")!;
    dumper.pose = { ...dumper.pose, ...spot.pos };
    expect(labels("R2")).toContain("shoot_now");
  });

  it("no partner within passRangeM -> no pass_to", () => {
    const { robot, labels } = setup();
    const feeder = robot("B3");
    expect(feeder.profile.passRangeM).toBeGreaterThan(0);
    expect(labels("B3")).toContain("pass_to:robot=B2");
    feeder.profile.passRangeM = 0.1;
    expect(hasAction(labels("B3"), "pass_to")).toBe(false);
  });

  it("not enough time for a climb level -> no climb at that level", () => {
    const { state, robot, labels } = setup();
    const r = robot("B1");
    r.profile.climbLevel = 3;
    r.profile.climbTimeS = 9; // 3 s per level
    r.pose = { ...r.pose, ...state.field.alliances.blue.tower };
    state.phase = "endgame";
    const margin = state.rules.triggers.climbSafetyMarginS;
    state.timeS = state.rules.matchS - (margin + 9.5);
    expect(labels("B1").filter((l) => l.startsWith("climb:"))).toEqual(["climb:1", "climb:2", "climb:3"]);
    state.timeS = state.rules.matchS - (margin + 6.5);
    expect(labels("B1").filter((l) => l.startsWith("climb:"))).toEqual(["climb:1", "climb:2"]);
    state.timeS = state.rules.matchS - (margin + 1);
    expect(labels("B1").filter((l) => l.startsWith("climb:"))).toEqual([]);
  });

  it("already aligned -> shoot_now instead of align_then_shoot", () => {
    const { state, robot, labels } = setup();
    const r = robot("B2"); // drum_fixed, drivetrain aim
    const spot = state.field.shotSpots.find((s) => s.alliance === "blue" && s.id === "left_wing")!;
    r.pose = { ...r.pose, ...spot.pos };
    r.alignment.aligned = false;
    expect(labels("B2")).toContain("align_then_shoot");
    expect(labels("B2")).not.toContain("shoot_now");
    r.alignment.aligned = true;
    expect(labels("B2")).toContain("shoot_now");
    expect(labels("B2")).not.toContain("align_then_shoot");
  });

  it("builds two-step options only from allowed pairs", () => {
    const { state, robot } = setup();
    const options = maskOptions(robot("B1"), state);
    const collect = options.find((o) => o.label === "collect:neutral")!;
    const followUps = maskThenOptions(collect, options);
    expect(new Set(followUps.map((o) => o.intent.action))).toEqual(new Set(["stage_fuel", "hold_fire_until_active", "goto_shot_spot"]));
    const pair = withThen(collect, followUps[0]!)!;
    expect(pair.label).toBe(`collect:neutral>${followUps[0]!.label}`);
    expect(IntentSchema.safeParse(pair.intent).success).toBe(true);
    expect(withThen(collect, options.find((o) => o.label === "hold_position")!)).toBeUndefined();
  });
});

describe("config", () => {
  it("parses and keeps the verified game constants", () => {
    const g = cfg.game;
    expect([g.autoS.value, g.teleopS.value]).toEqual([20, 140]);
    expect([g.fuelPointsActiveHub.value, g.fuelPointsInactiveHub.value]).toEqual([1, 0]);
    expect(g.towerTeleopPoints.value).toEqual([10, 20, 30]);
    expect(g.towerAutoL1Points.value).toBe(15);
    expect([g.minorFoulPoints.value, g.majorFoulPoints.value]).toEqual([5, 15]);
    expect(g.maxPreloadFuel.value).toBe(8);
    expect(g.hubDeactivationWarningS.value).toBe(3);
    expect(g.allHubsActiveAtEnd.value).toBe(true);
    for (const key of ["autoS", "teleopS", "fuelPointsActiveHub", "towerTeleopPoints", "minorFoulPoints", "maxPreloadFuel"] as const) {
      expect(g[key].status, key).toBe("VERIFIED");
    }
  });

  it("records which constants the manual verified and which are still open", () => {
    // Verified against the official manual with page citations (NDI extract, data/rules/rules.json).
    for (const key of ["hubShiftSchedule", "endgameS", "pinning"] as const) {
      expect(cfg.game[key].status, key).toBe("VERIFIED");
      expect(cfg.game[key].source, key).toMatch(/Game Manual .* p\.\d+/);
    }
    expect(cfg.game.pinning.value.clauseId).toBe("G418");
    // Not found in the manual, or found without a citation: still open.
    // Taken from a public source outside the manual, and labelled as such.
    expect(cfg.game.fuelMassKg.status).toBe("EXTERNAL_SOURCE");
    expect(cfg.field.allianceZoneDepthM.status).toBe("TODO_VERIFY_AGAINST_MANUAL");
  });

  it("has a consistent teleop timeline", () => {
    const s = cfg.game.hubShiftSchedule.value;
    expect(s.transitionS + s.numShifts * s.shiftS + cfg.game.endgameS.value).toBe(cfg.game.teleopS.value);
  });

  it("has a template for every archetype that yields a valid profile", () => {
    for (const archetype of ARCHETYPES) {
      const profile = profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id: archetype, teamLabel: archetype }, cfg.game.fuelMassKg.value);
      expect(profile.archetype).toBe(archetype);
      expect(profile.speedFullMps).toBeLessThanOrEqual(profile.speedEmptyMps);
    }
    expect(cfg.archetypes._status).toBe("FABRICATED");
  });

  it("keeps dev and eval seeds separate", () => {
    expect(cfg.seeds.dev.filter((s) => cfg.seeds.eval.includes(s))).toEqual([]);
  });

  it("uses the configured micro-rollout and answer-key sizes", () => {
    expect(cfg.microRollouts).toMatchObject({ count: 20, horizonS: 2 });
    expect(cfg.answerKey).toMatchObject({ rollouts: 50, horizonS: 20 });
  });
});

describe("results, events, providers", () => {
  it("has exactly the headline keys", () => {
    expect(HEADLINE_KEYS).toEqual([
      "live_margin_drex_realtime", "live_margin_deepinfra_realtime", "live_margin_drex_paused", "live_margin_deepinfra_paused",
      "drex_p50_ms", "drex_p95_ms", "deepinfra_p50_ms", "openai_p50_ms", "latency_ratio_deepinfra_over_drex", "latency_ratio_openai_over_drex",
      "drex_cost_per_1k_usd", "deepinfra_cost_per_1k_usd", "openai_cost_per_1k_usd",
      "batch1_ms_per_decision_drex", "batch1_ms_per_decision_giant", "batch3_ms_per_decision_drex", "batch3_ms_per_decision_giant",
      "batch8_ms_per_decision_drex", "batch8_ms_per_decision_giant", "batch32_ms_per_decision_drex", "batch32_ms_per_decision_giant",
      "top1_drex", "top1_deepinfra", "top1_openai", "top1_scripted", "top1_random",
      "regret_drex", "regret_deepinfra", "regret_openai", "regret_scripted", "regret_random",
      "context_sensitivity_drex", "context_sensitivity_deepinfra", "context_sensitivity_openai", "top1_drex_anonymized",
      "rollouts_to_best_drex", "rollouts_to_best_uniform", "rollouts_to_best_deepinfra", "rollout_savings_pct_drex_vs_uniform",
      "n_scenarios", "n_families", "n_live_seeds", "matches_per_sec", "sim_matches_per_hour_drex", "sim_matches_per_hour_deepinfra",
      "usage_drex_questions", "usage_ndi_docs", "usage_ndi_pages", "usage_intern_sessions", "usage_intern_system1_judgments",
      "usage_deepinfra_calls", "usage_keenable_requests",
      "lab_proposals_total", "lab_proposals_beating_baseline", "keenable_pages", "ndi_rules_verified_pct",
      "all_real",
    ]);
    expect(HEADLINE_KEYS.some((k) => k.includes("claude"))).toBe(false);
    const empty = emptyHeadline();
    expect(Object.values(empty).every((v) => v === null)).toBe(true);
    expect(HeadlineSchema.safeParse(empty).success).toBe(true);
    expect(HeadlineSchema.safeParse({ ...empty, extra: 1 }).success).toBe(false);
  });

  it("has exactly the provider ids", () => {
    expect([...PROVIDER_IDS]).toEqual(["drex", "drex_mock", "deepinfra", "openai", "gemini", "scripted", "random"]);
    expect(cfg.providers.byId.deepinfra.modelPreference?.length).toBeGreaterThan(0);
    expect(cfg.research.maxRequests).toBe(300);
  });

  it("has exactly the engine event kinds and run event types", () => {
    const kinds = EngineEventSchema.options.map((o) => o.shape.kind.value);
    expect(kinds.sort()).toEqual(
      [
        "action_done", "action_failed", "action_timeout", "contact_start", "contact_long", "pinned", "no_progress", "path_blocked",
        "hopper_full", "hopper_empty", "hub_shift", "hub_warning", "endgame_start", "opponent_in_range", "score", "foul", "watchdog",
      ].sort(),
    );
    const types = RunEventSchema.options.map((o) => o.shape.type.value);
    expect(types).toEqual(["run_start", "decision", "engine_event", "score", "foul", "scenario_result", "rollout_batch", "run_end"]);
  });
});
