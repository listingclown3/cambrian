/**
 * Simulate lab proposals: paired matches on the eval seeds. Blue alliance uses a wrapper around the
 * scripted baseline that returns the proposal's intent when a deterministic predicate (our reading
 * of the proposal's plain-words situation) holds; red always uses the baseline. Compared per seed
 * with baseline-vs-baseline on the same seed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  dist,
  intentLabel,
  maskThenOptions,
  withThen,
  type Config,
  type Intent,
  type IntentOption,
  type ObservationView,
  type Proposal,
  type ScriptedPolicy,
} from "../contracts";
import { ENGINE_IS_STUB, engine } from "../engine";
import { demoRobots, MatchRunner, SCRIPTED_POLICIES } from "../exec";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

/** A one-line statement of how the plain words were read, and the deterministic predicate. */
export interface Reading {
  summary: string;
  applies(view: ObservationView): boolean;
}

const DEPOT_RADIUS_M = 1.5;
const noContact = (v: ObservationView) => v.self.contact.withRobotId === null;
type SelfZone = "depot" | "neutral" | "our_alliance" | "their_alliance";
export function zoneOf(v: ObservationView): SelfZone {
  const a = v.field.alliances;
  if (dist(v.self.pose, a[v.self.alliance]!.depot) <= DEPOT_RADIUS_M) return "depot";
  const { x } = v.self.pose;
  const abs = x <= a.blue!.zone.x1 ? "blue" : x >= a.red!.zone.x0 ? "red" : "neutral";
  return abs === "neutral" ? "neutral" : abs === v.self.alliance ? "our_alliance" : "their_alliance";
}
const bothActive = (v: ObservationView) => v.hubs.ours.active && v.hubs.theirs.active;

/** Readings keyed by proposal id. A proposal with no entry cannot be simulated. */
export const READINGS: Record<string, Reading> = {
  endgame_dump_full_hopper_climb3: {
    summary: "matchRemainingS <= 30 AND both hubs active AND fuelHeld >= 6 AND own alliance zone AND no contact",
    applies: (v) => v.matchRemainingS <= 30 && bothActive(v) && v.self.fuelHeld >= 6 && zoneOf(v) === "our_alliance" && noContact(v),
  },
  inactive_shift_depot_gather: {
    summary: `our hub inactive AND timeToShiftS >= 5 AND fuelHeld <= 2 AND within ${DEPOT_RADIUS_M} m of own depot (the depot is a point, so 'in the depot zone' is read as that radius) AND no contact`,
    applies: (v) => !v.hubs.ours.active && v.hubs.ours.timeToShiftS >= 5 && v.self.fuelHeld <= 2 && zoneOf(v) === "depot" && noContact(v),
  },
  trench_shoot_on_move_refill: {
    summary: "our hub active AND timeToShiftS >= 10 AND fuelHeld >= 4 AND in own alliance zone or neutral zone AND no contact",
    applies: (v) => v.hubs.ours.active && v.hubs.ours.timeToShiftS >= 10 && v.self.fuelHeld >= 4 && ["our_alliance", "neutral"].includes(zoneOf(v)) && noContact(v),
  },
  spin_out_then_shadow_defend: {
    summary:
      "in contact with an opposing robot for >= 2 s (the id 'R1' in the text is a placeholder: read as whichever opponent is in contact, and the defend step targets that robot) AND our hub active AND timeToShiftS >= 15 AND fuelHeld >= 3",
    applies: (v) => {
      const c = v.self.contact;
      const other = c.withRobotId ? v.robots.find((r) => r.id === c.withRobotId) : undefined;
      return !!other && !other.isPartner && c.contactS >= 2 && v.hubs.ours.active && v.hubs.ours.timeToShiftS >= 15 && v.self.fuelHeld >= 3;
    },
  },
  late_climb_level2_not_cycle: {
    summary: "10 <= matchRemainingS <= 30 AND fuelHeld <= 2 AND own alliance zone AND no contact",
    applies: (v) => v.matchRemainingS <= 30 && v.matchRemainingS >= 10 && v.self.fuelHeld <= 2 && zoneOf(v) === "our_alliance" && noContact(v),
  },
};

/** Find the proposal's intent among the masked options, or build it with withThen. Undefined when not offered. */
export function resolveIntent(view: ObservationView, intent: Intent): Intent | undefined {
  const find = (target: { action: string; params: unknown }, from: readonly IntentOption[]) =>
    from.find((o) => !o.intent.then && o.intent.action === target.action && JSON.stringify(o.intent.params) === JSON.stringify(target.params));
  const first = find(intent, view.options);
  if (!first) return undefined;
  if (!intent.then) return first.intent;
  let thenTarget: { action: string; params: unknown } = intent.then;
  // a robot id in the text is a placeholder: substitute the robot we are in contact with
  if (thenTarget.action === "defend" && view.self.contact.withRobotId) thenTarget = { action: "defend", params: { robotId: view.self.contact.withRobotId } };
  const second = find(thenTarget, maskThenOptions(first, view.options));
  return second ? withThen(first, second)?.intent : undefined;
}

export function wrapPolicy(base: ScriptedPolicy, proposal: Proposal, reading: Reading, counter: { fired: number; applied: number }): ScriptedPolicy {
  return {
    id: `${base.id}+${proposal.id}`,
    decide(view) {
      if (view.self.alliance === "blue" && !(view.self.climb.inProgress && view.self.intent) && reading.applies(view)) {
        counter.applied += 1;
        const intent = resolveIntent(view, proposal.intent);
        if (intent) {
          counter.fired += 1;
          return intent;
        }
      }
      return base.decide(view);
    },
  };
}

/** Red always plays the baseline, blue the given policy: dispatch on alliance. */
function split(blue: ScriptedPolicy, red: ScriptedPolicy): ScriptedPolicy {
  return { id: `${blue.id}|${red.id}`, decide: (v) => (v.self.alliance === "blue" ? blue : red).decide(v) };
}

function playMargin(cfg: Config, seed: number, policy: ScriptedPolicy): number {
  const runner = new MatchRunner(engine, cfg, seed, demoRobots(cfg, { blue: policy.id, red: "basic_cycle" }), { default: policy });
  const { state } = runner.runToEnd();
  return state.score.blue.total - state.score.red.total;
}

const T95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
export function meanAndHalfWidth(xs: number[]): { mean: number; ci95: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, ci95: 0 };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, ci95: ((T95[n - 1] ?? 1.96) * sd) / Math.sqrt(n) };
}

type Stored = Proposal & { predicateSummary?: string; simulated?: boolean; simulationNote?: string };

export function simulateAll(cfg: Config): void {
  if (ENGINE_IS_STUB) throw new Error("engine is a stub");
  const file = repoPath("data", "lab", "proposals.json");
  const whole = JSON.parse(readFileSync(file, "utf8")) as { proposals: Stored[] };
  const base = SCRIPTED_POLICIES["basic_cycle"]!;
  const seeds = cfg.seeds.eval.slice(0, cfg.lab.matchesPerProposal);
  const baseMargins = seeds.map((s) => playMargin(cfg, s, split(base, base)));
  console.log(`[lab-sim] baseline margins (blue-red) on ${seeds.length} eval seeds: ${baseMargins.join(", ")}`);
  const rows: Record<string, unknown>[] = [];
  for (const p of whole.proposals) {
    const reading = READINGS[p.id];
    if (!reading) {
      p.simulated = false;
      p.simulationNote = "no deterministic predicate could be written for this situation";
      rows.push({ proposalId: p.id, simulated: false, reason: p.simulationNote, marginVsBaseline: null, ci95: null, nMatches: null, scenarioValue: null, beatsBaseline: null });
      continue;
    }
    p.predicateSummary = reading.summary;
    const counter = { fired: 0, applied: 0 };
    const diffs: number[] = [];
    const fires: number[] = [];
    seeds.forEach((s, i) => {
      const before = counter.fired;
      const m = playMargin(cfg, s, split(wrapPolicy(base, p, reading, counter), base));
      fires.push(counter.fired - before);
      diffs.push(m - baseMargins[i]!);
    });
    const { mean, ci95 } = meanAndHalfWidth(diffs);
    const neverFired = counter.fired === 0;
    p.simulated = !neverFired;
    p.simulationNote = neverFired ? `the intent never fired in ${seeds.length} matches (predicate true ${counter.applied} times, but the intent was not among the masked options, or the predicate was never true): NOT TESTED` : "";
    rows.push({
      proposalId: p.id,
      intent: intentLabel(p.intent),
      simulated: !neverFired,
      reason: p.simulationNote || null,
      marginVsBaseline: neverFired ? null : mean,
      ci95: neverFired ? null : ci95,
      nMatches: seeds.length,
      scenarioValue: null,
      beatsBaseline: neverFired ? null : mean - ci95 > 0,
      firesPerMatch: counter.fired / seeds.length,
      firesByMatch: fires,
      predicateAppliedTotal: counter.applied,
      marginDiffBySeed: diffs,
      seeds,
    });
    console.log(`[lab-sim] ${p.id}: diff ${mean.toFixed(2)} +- ${ci95.toFixed(2)}, fires/match ${(counter.fired / seeds.length).toFixed(2)}, applied ${counter.applied}`);
  }
  writeFileSync(file, JSON.stringify(whole, null, 2) + "\n");
  const prev = JSON.parse(readFileSync(repoPath("results", "lab.json"), "utf8")) as { summary: Record<string, unknown> };
  const tested = rows.filter((r) => r.simulated === true);
  writeResults({
    experiment: "lab",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { lab: cfg.lab, seeds, baselinePolicy: base.id, baselineMarginsBlueMinusRed: baseMargins },
    rows,
    summary: { ...prev.summary, lab_proposals_beating_baseline: tested.filter((r) => r.beatsBaseline === true).length, proposalsTested: tested.length, simulated: tested.length > 0 },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) simulateAll(loadConfig());
