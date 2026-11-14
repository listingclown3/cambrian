/**
 * Tower post-up test case: in endgame, shoot from a spot next to our own tower versus a normal
 * shot spot, paired on the eval seeds (blue plays the variant, red the baseline), margin
 * difference with 95% CI and the G420 fouls opponents draw. Spot ids are found at runtime; with
 * no post-up spot in config.field.shotSpots the result is "not run: engine support pending".
 */
import type { Config, Intent, ObservationView, ScriptedPolicy } from "../contracts";
import { ENGINE_IS_STUB, engine } from "../engine";
import { demoRobots, MatchRunner, SCRIPTED_POLICIES } from "../exec";
import { meanAndHalfWidth } from "./labSim";

export type TowerResult =
  | { run: false; reason: string }
  | { run: true; spotId: string; controlSpotId: string; marginDiff: number; ci95: number; n: number; fires: number; g420FoulsOnOpponents: number; g420FoulsOnUs: number };

export function findPostUpSpot(cfg: Config): string | null {
  return cfg.field.shotSpots.spots.find((s) => /post.?up/i.test(s.id))?.id ?? null;
}

function toSpot(base: ScriptedPolicy, spotId: string, counter: { fired: number }): ScriptedPolicy {
  return {
    id: `${base.id}+goto_${spotId}`,
    decide(view: ObservationView): Intent {
      if (view.self.alliance === "blue" && view.matchRemainingS <= 30 && view.self.fuelHeld > 0 && !(view.self.climb.inProgress && view.self.intent)) {
        const o = view.options.find((x) => !x.intent.then && x.intent.action === "goto_shot_spot" && (x.intent.params as { spotId?: string }).spotId === spotId);
        if (o) {
          counter.fired += 1;
          return o.intent;
        }
      }
      return base.decide(view);
    },
  };
}

function play(cfg: Config, seed: number, blue: ScriptedPolicy, base: ScriptedPolicy) {
  const policy: ScriptedPolicy = { id: blue.id, decide: (v) => (v.self.alliance === "blue" ? blue : base).decide(v) };
  const { state } = new MatchRunner(engine, cfg, seed, demoRobots(cfg, { blue: policy.id, red: "basic_cycle" }), { default: policy }).runToEnd();
  const g420 = state.fouls.filter((f) => f.clauseId.startsWith("G420"));
  return { margin: state.score.blue.total - state.score.red.total, onOpp: g420.filter((f) => f.byAlliance === "red").length, onUs: g420.filter((f) => f.byAlliance === "blue").length };
}

export function compareTowerPostUp(cfg: Config, controlSpotId = "hub_close"): TowerResult {
  const spot = findPostUpSpot(cfg);
  if (ENGINE_IS_STUB || !spot) return { run: false, reason: "not run: engine support pending (no post-up shot spot in config.field.shotSpots)" };
  const base = SCRIPTED_POLICIES["basic_cycle"]!;
  const seeds = cfg.seeds.eval.slice(0, cfg.lab.matchesPerProposal);
  const fired = { fired: 0 };
  const diffs: number[] = [];
  let onOpp = 0;
  let onUs = 0;
  for (const s of seeds) {
    const control = play(cfg, s, toSpot(base, controlSpotId, { fired: 0 }), base);
    const treat = play(cfg, s, toSpot(base, spot, fired), base);
    diffs.push(treat.margin - control.margin);
    onOpp += treat.onOpp;
    onUs += treat.onUs;
  }
  const { mean, ci95 } = meanAndHalfWidth(diffs);
  return { run: true, spotId: spot, controlSpotId, marginDiff: mean, ci95, n: seeds.length, fires: fired.fired, g420FoulsOnOpponents: onOpp, g420FoulsOnUs: onUs };
}
