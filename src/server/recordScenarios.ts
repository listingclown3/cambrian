/**
 * Writes src/server/fixtures/scenarios_fixture.json (owner: P4): a SMALL scenario fixture that follows
 * src/contracts/scenario.ts, built on the STUB engine with real (stub-engine) rollouts for the answer key.
 * Answer-key values and the Drex/giant picks are hand-authored for illustration, never measured.
 * The web client shows a FIXTURE banner for this data. `pnpm record:scenarios` regenerates it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getRobot, maskOptions, type AnswerKey, type MatchState, type Scenario, type ScenarioFamily } from "../contracts";
import { engine } from "../engine";
import { buildObservationView } from "../engine/observe";
import { basicCyclePolicy, demoRobots, holdPolicy, robotsNeedingDecision } from "../exec";
import { loadConfig, repoPath } from "../util/config";

const cfg = loadConfig();
const N = 40;
const FOCUS = "B1";

const PRIORITY = ["shoot_now", "align_then_shoot", "hold_fire_until_active", "collect:neutral", "collect:depot", "load_outpost", "goto_shot_spot", "climb", "hold_position", "goto_zone:neutral"];
function pickOptions<T extends { label: string }>(all: T[]): T[] {
  const rank = (l: string) => { const i = PRIORITY.findIndex((p) => l.startsWith(p)); return i < 0 ? 99 : i; };
  return [...all].sort((a, b) => rank(a.label) - rank(b.label)).slice(0, 7);
}
/** Hand-authored illustrative point margins, shaped by hub state and hopper load. NOT a measurement. */
function authored(label: string, active: boolean, left: number, fuel: number, cap: number): number {
  const shoot = label === "shoot_now" || label === "align_then_shoot";
  if (shoot) return fuel === 0 ? -8 : active ? 3 + fuel * 1.4 - (left < 3 && label === "align_then_shoot" ? 6 : 0) : -3;
  if (label === "hold_fire_until_active") return fuel === 0 ? -5 : active ? -2 : 5 + fuel * 0.4;
  if (label.startsWith("collect") || label === "load_outpost") return fuel >= cap ? -5 : 9 - fuel * 1.3 - (active && fuel > 3 ? 3 : 0);
  if (label.startsWith("goto_shot_spot")) return fuel > 0 && active ? 2 : -1;
  if (label.startsWith("climb")) return -2;
  return -4;
}

function playTo(seed: number, timeS: number): MatchState {
  const state = engine.createMatch(cfg, seed, demoRobots(cfg));
  let last: ReturnType<typeof engine.step>["events"] = [];
  while (state.timeS < timeS && state.phase !== "finished") {
    const intents: Record<string, import("../contracts").Intent> = {};
    for (const id of robotsNeedingDecision(state, last)) intents[id] = basicCyclePolicy.decide(buildObservationView(state, id, last));
    last = engine.step(state, intents, state.rules.physics.dtS).events;
  }
  return state;
}

interface Variant { flip: string; mutate?: (s: MatchState) => void }
const families: { family: ScenarioFamily; seed: number; at: number; variants: Variant[] }[] = [
  {
    family: { id: "fx_hub_timing", stickyType: "hub_about_to_deactivate", description: "Our hub's active window is about to close. Do we keep shooting or reposition?", baseScenarioId: "fx_hub_timing_base" },
    seed: 11, at: 50,
    variants: [
      { flip: "" , mutate: (s) => { s.hubs.blue = { active: true, timeToShiftS: 2.5, warning: true }; if (getRobot(s, FOCUS).fuelHeld < 4) getRobot(s, FOCUS).fuelHeld = 6; } },
      { flip: "hub stays active for 20 more seconds", mutate: (s) => { s.hubs.blue = { active: true, timeToShiftS: 20, warning: false }; getRobot(s, FOCUS).fuelHeld = 6; } },
      { flip: "hub is already inactive for 20 seconds", mutate: (s) => { s.hubs.blue = { active: false, timeToShiftS: 20, warning: false }; getRobot(s, FOCUS).fuelHeld = 6; } },
    ],
  },
  {
    family: { id: "fx_fuel_load", stickyType: "carry_or_collect", description: "How much fuel we carry decides whether to score now or go collect.", baseScenarioId: "fx_fuel_load_base" },
    seed: 12, at: 70,
    variants: [
      { flip: "", mutate: (s) => { s.hubs.blue = { active: true, timeToShiftS: 15, warning: false }; getRobot(s, FOCUS).fuelHeld = 3; } },
      { flip: "hopper is empty", mutate: (s) => { s.hubs.blue = { active: true, timeToShiftS: 15, warning: false }; getRobot(s, FOCUS).fuelHeld = 0; } },
      { flip: "hopper is full", mutate: (s) => { s.hubs.blue = { active: true, timeToShiftS: 15, warning: false }; const r = getRobot(s, FOCUS); r.fuelHeld = r.profile.capacity; } },
    ],
  },
];

let rng = 12345;
const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const scenarios: Scenario[] = [];
const picks: Record<string, Record<string, { label: string; probabilities?: Record<string, number> } | null>> = {};

for (const f of families) {
  f.variants.forEach((v, vi) => {
    const state = playTo(f.seed, f.at);
    v.mutate?.(state);
    const id = vi === 0 ? f.family.baseScenarioId : `${f.family.id}_v${vi}`;
    const robot = getRobot(state, FOCUS);
    const options = pickOptions(maskOptions(robot, state));
    const snap = engine.snapshot(state);
    const values: AnswerKey["values"] = {};
    for (const o of options) {
      // ILLUSTRATIVE authored value (the stub engine's rollouts are flat); see the fixture note.
      const mean = authored(o.label, state.hubs.blue.active, state.hubs.blue.timeToShiftS, robot.fuelHeld, robot.profile.capacity);
      values[o.label] = { mean, ci95: 1.2 + ((o.label.length * 7) % 10) / 6, n: N };
    }
    const ranked = Object.entries(values).sort((a, b) => b[1].mean - a[1].mean);
    const [best, bv] = ranked[0]!;
    const rv = ranked[1]![1];
    const ambiguous = bv.mean - bv.ci95 <= rv.mean + rv.ci95;
    const scripted = basicCyclePolicy.decide(buildObservationView(state, FOCUS, []));
    const scriptedLabel = options.find((o) => JSON.stringify(o.intent) === JSON.stringify(scripted))?.label ?? null;
    void holdPolicy;
    scenarios.push({ id, familyId: f.family.id, flip: v.flip, snapshot: snap, focusRobotId: FOCUS, options, answerKey: { values, best, ambiguous } });
    // ILLUSTRATIVE picks for Drex and the giant (neither was run on these); probabilities are softmax of the authored means.
    const second = ranked[1]![0];
    const z = Object.values(values).reduce((a, v) => a + Math.exp(v.mean / 4), 0);
    const probabilities = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Math.exp(v.mean / 4) / z]));
    picks[id] = {
      scripted: scriptedLabel ? { label: scriptedLabel } : null,
      random: { label: options[Math.floor(rand() * options.length)]!.label },
      drex: { label: id === "fx_fuel_load_v2" ? second : best, probabilities },
      deepinfra: { label: id === "fx_hub_timing_base" ? second : best },
    };
  });
}

const out = {
  isMock: true,
  note: "FIXTURE: snapshots come from the stub engine; the answer-key numbers and the Drex and giant picks are hand-authored for illustration. None of it is a measurement.",
  families: families.map((f) => f.family),
  scenarios,
  picks,
};
mkdirSync(repoPath("src", "server", "fixtures"), { recursive: true });
writeFileSync(repoPath("src", "server", "fixtures", "scenarios_fixture.json"), JSON.stringify(out));
console.log(`wrote ${scenarios.length} scenarios; options per scenario: ${scenarios.map((s) => s.options.length).join(",")}`);
