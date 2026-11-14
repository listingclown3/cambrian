/**
 * Scripted policies (owner: P1). Synchronous baselines, also used to drive the robots that are
 * not being evaluated during rollouts.
 *
 * STUB: one simple collect-then-score cycle. P1 adds archetype-aware policies here.
 */
import { dist, type Intent, type ObservationView, type ScriptedPolicy } from "../contracts";

/** Collect until half full, score when our hub is active, climb in endgame. */
export const basicCyclePolicy: ScriptedPolicy = {
  id: "basic_cycle",
  decide(view: ObservationView): Intent {
    const { self, options } = view;
    const byLabel = (label: string) => options.find((o) => o.label === label)?.intent;
    const byAction = (action: string) => options.filter((o) => o.intent.action === action);
    const hold: Intent = { action: "hold_position", params: {} };

    // Never interrupt a climb that is under way.
    if (self.climb.inProgress && self.intent) return self.intent;

    if (view.phase === "endgame") {
      const climbs = byAction("climb");
      const best = climbs[climbs.length - 1];
      if (best) return best.intent;
    }

    const wantsToScore = self.fuelHeld > 0 && (self.fuelHeld >= self.profile.capacity / 2 || byAction("collect").length === 0);
    if (wantsToScore) {
      const shoot = byLabel("shoot_now") ?? byLabel("align_then_shoot");
      if (shoot) return view.hubs.ours.active ? shoot : (byLabel("hold_fire_until_active") ?? shoot);
      // Not in range: drive to the nearest spot this robot can score from.
      const spots = view.field.shotSpots
        .filter((s) => s.alliance === self.alliance)
        .filter((s) => s.distanceToHubM >= self.profile.minShotDistanceM && s.distanceToHubM <= self.profile.maxShotDistanceM)
        .sort((a, b) => dist(self.pose, a.pos) - dist(self.pose, b.pos));
      // Already drove to a spot and still cannot shoot from here (spot taken): do not loop on it.
      const justArrived = view.recentEvents.some((e) => e.kind === "action_done" && e.robotId === self.id && e.action === "goto_shot_spot");
      const goto = !justArrived && spots[0] && byLabel(`goto_shot_spot:${spots[0].id}`);
      if (goto) return goto;
      if (justArrived && byLabel("dump_unaligned") && self.profile.shooterType !== "dumper") return byLabel("dump_unaligned")!;
    }

    const fuel = view.fuel.byZone;
    if (fuel.neutral > 0 && byLabel("collect:neutral")) return byLabel("collect:neutral")!;
    if (fuel[`${self.alliance}_depot`] > 0 && byLabel("collect:depot")) return byLabel("collect:depot")!;
    if (fuel[`${self.alliance}_outpost`] > 0 && byLabel("load_outpost")) return byLabel("load_outpost")!;
    return byLabel("hold_position") ?? hold;
  },
};

/** Never moves. Useful as a control in tests and rollouts. */
export const holdPolicy: ScriptedPolicy = {
  id: "hold",
  decide(): Intent {
    return { action: "hold_position", params: {} };
  },
};

/** Policy used by `pnpm match` and other tools when none is named. */
export const DEFAULT_POLICY_ID = "basic_cycle";

/** Registry of scripted policies by id. */
export const SCRIPTED_POLICIES: Record<string, ScriptedPolicy> = {
  [basicCyclePolicy.id]: basicCyclePolicy,
  [holdPolicy.id]: holdPolicy,
};
