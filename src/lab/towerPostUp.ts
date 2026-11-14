/**
 * Tower post-up test case: in endgame, shoot from a spot next to our own tower versus a normal
 * shot spot, paired on the eval seeds (blue plays the variant, red the baseline), margin
 * difference with 95% CI and the G420 fouls opponents draw. Spots are found at runtime in the built
 * layout (ids starting "tower_post"); with none the result is "not run: engine support pending".
 */
import { dist, type Config, type Intent, type ObservationView, type ScriptedPolicy } from "../contracts";
import { ENGINE_IS_STUB, buildFieldLayout, engine } from "../engine";
import { demoRobots, MatchRunner, SCRIPTED_POLICIES } from "../exec";
import { meanAndHalfWidth } from "./labSim";

export type TowerResult =
  | { run: false; reason: string }
  | { run: true; spotId: string; controlSpotId: string; marginDiff: number; ci95: number; n: number; fires: number; g420FoulsOnOpponents: number; g420FoulsOnUs: number };

const isPostUp = (id: string) => id.startsWith("tower_post");

/** Ids of the blue alliance's tower post-up spots in the built layout (derived from field geometry). */
export function findPostUpSpots(cfg: Config): string[] {
  return buildFieldLayout(cfg).shotSpots.filter((x) => x.alliance === "blue" && isPostUp(x.id)).map((x) => x.id);
}

/**
 * Blue, in endgame with fuel: go to the nearest offered spot of the wanted kind (post-up or normal;
 * the normal one is the nearest normal spot the robot can score from, i.e. offered as an option).
 */
function toSpot(base: ScriptedPolicy, wantPostUp: boolean, counter: { fired: number }): ScriptedPolicy {
  return {
    id: `${base.id}+goto_${wantPostUp ? "post_up" : "normal"}`,
    decide(view: ObservationView): Intent {
      if (view.self.alliance === "blue" && view.matchRemainingS <= 30 && view.self.fuelHeld > 0 && !(view.self.climb.inProgress && view.self.intent)) {
        const spots = new Map(view.field.shotSpots.filter((x) => x.alliance === "blue").map((x) => [x.id, x]));
        const cands = view.options
          .filter((o) => !o.intent.then && o.intent.action === "goto_shot_spot")
          .map((o) => ({ o, spot: spots.get((o.intent.params as { spotId: string }).spotId) }))
          .filter((c) => c.spot && isPostUp(c.spot.id) === wantPostUp)
          .sort((p, q) => dist(view.self.pose, p.spot!.pos) - dist(view.self.pose, q.spot!.pos));
        // once we are at the spot (within 0.5 m) let the baseline shoot; otherwise a repeated goto would never fire
        if (cands[0] && dist(view.self.pose, cands[0].spot!.pos) > 0.5) {
          counter.fired += 1;
          return cands[0].o.intent;
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

export function compareTowerPostUp(cfg: Config, ): TowerResult {
  const spots = findPostUpSpots(cfg);
  if (ENGINE_IS_STUB || spots.length === 0) return { run: false, reason: "not run: engine support pending (no tower_post* shot spot in the built field layout)" };
  const base = SCRIPTED_POLICIES["basic_cycle"]!;
  const seeds = cfg.seeds.eval.slice(0, cfg.lab.matchesPerProposal);
  const fired = { fired: 0 };
  const diffs: number[] = [];
  let onOpp = 0;
  let onUs = 0;
  for (const s of seeds) {
    const control = play(cfg, s, toSpot(base, false, { fired: 0 }), base);
    const treat = play(cfg, s, toSpot(base, true, fired), base);
    diffs.push(treat.margin - control.margin);
    onOpp += treat.onOpp;
    onUs += treat.onUs;
  }
  const { mean, ci95 } = meanAndHalfWidth(diffs);
  return { run: true, spotId: spots.join(","), controlSpotId: "nearest normal spot offered", marginDiff: mean, ci95, n: seeds.length, fires: fired.fired, g420FoulsOnOpponents: onOpp, g420FoulsOnUs: onUs };
}
