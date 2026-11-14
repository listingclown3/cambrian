/**
 * Scripted policies (owner: P1). Synchronous baselines, also used to drive the robots that are
 * not being evaluated during rollouts.
 *
 *   basic_cycle - one collect-then-score cycle for every robot (the original baseline)
 *   archetype   - plays to the robot's archetype: defenders defend, feeders pass, the
 *                 zero-hopper turret shoots as it collects, dumpers score only from the hub,
 *                 drum and lane shooters align first, turrets shoot on the move; escapes pins
 *   hold        - never moves (a control)
 *
 * The few numbers in here are strategy heuristics of a scripted baseline, not game or physics
 * constants; they are named and commented where they are defined.
 */
import { climbTimeForLevel, dist, type Intent, type ObservationView, type ScriptedPolicy, type ShotSpot } from "../contracts";

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

// ── archetype-aware policy ───────────────────────────────────────────────────

/** Heuristic: start the climb when time left is under this multiple of the time the climb needs. */
const CLIMB_START_FACTOR = 1.5;
/** Heuristic: a shot spot counts as taken when a partner is within this distance of it, metres (about one robot width). */
const SPOT_TAKEN_M = 0.9;
/** Heuristic: go score once the hopper is at least this full (fraction of capacity). */
const SCORE_WHEN_FULL_FRACTION = 0.6;

function optionIndex(view: ObservationView): Map<string, Intent> {
  const m = new Map<string, Intent>();
  for (const o of view.options) m.set(o.label, o.intent);
  return m;
}

/** Spots this robot can score from, best first: free of partners, then closest. */
function scoringSpots(view: ObservationView): ShotSpot[] {
  const { self } = view;
  const p = self.profile;
  return view.field.shotSpots
    .filter((s) => s.alliance === self.alliance && s.distanceToHubM >= p.minShotDistanceM && s.distanceToHubM <= p.maxShotDistanceM)
    .map((s) => ({ s, taken: view.robots.some((r) => r.isPartner && dist(r.pose, s.pos) < SPOT_TAKEN_M), d: dist(self.pose, s.pos) }))
    .sort((a, b) => Number(a.taken) - Number(b.taken) || a.d - b.d)
    .map((x) => x.s);
}

/** True when an event addressed to this robot (optionally for one action) is among its recent events. */
function lastOwnEvent(view: ObservationView, kind: string, action?: string): boolean {
  return view.recentEvents.some(
    (e) => e.kind === kind && "robotId" in e && e.robotId === view.self.id && (action === undefined || ("action" in e && e.action === action)),
  );
}

/** The best opponent to defend: a shooter with fuel, nearest its own hub. */
function defendTarget(view: ObservationView): string | null {
  const theirHub = view.field.alliances[view.self.alliance === "red" ? "blue" : "red"].hub;
  const candidates = view.robots
    .filter((r) => !r.isPartner && r.traits.shooterType !== "none" && r.climbLevel === 0)
    .sort((a, b) => Number(a.fuelLevel === "empty") - Number(b.fuelLevel === "empty") || dist(a.pose, theirHub) - dist(b.pose, theirHub));
  return candidates[0]?.id ?? null;
}

function collectIntent(view: ObservationView, opts: Map<string, Intent>): Intent | undefined {
  const fuel = view.fuel.byZone;
  const self = view.self;
  const ownZone = view.field.alliances[self.alliance].zone;
  const inOwnZone = ownZone.x0 <= self.pose.x && self.pose.x <= ownZone.x1;
  if (fuel.neutral > 0 && opts.has("collect:neutral")) return opts.get("collect:neutral");
  if (inOwnZone && fuel[`${self.alliance}_alliance`] > 0 && opts.has("collect:local")) return opts.get("collect:local");
  if (fuel[`${self.alliance}_depot`] > 0 && opts.has("collect:depot")) return opts.get("collect:depot");
  if (fuel[`${self.alliance}_outpost`] > 0 && opts.has("load_outpost")) return opts.get("load_outpost");
  return undefined;
}

/** Shoot from here, or get to a spot to shoot from. Undefined when there is nothing sensible. */
function scoreIntent(view: ObservationView, opts: Map<string, Intent>): Intent | undefined {
  const { self } = view;
  const p = self.profile;
  const active = view.hubs.ours.active;
  const shoot = opts.get("shoot_now") ?? opts.get("align_then_shoot");
  if (shoot) {
    if (active) return p.aimMethod === "drivetrain" && !self.aligned ? (opts.get("align_then_shoot") ?? shoot) : shoot;
    return opts.get("hold_fire_until_active") ?? shoot;
  }
  const spots = scoringSpots(view);
  if (p.shootOnMove && active) {
    for (const s of spots) {
      const sotm = opts.get(`shoot_on_move:spot=${s.id}`);
      if (sotm) return sotm;
    }
  }
  if (!lastOwnEvent(view, "action_done", "goto_shot_spot")) {
    for (const s of spots) {
      const go = opts.get(`goto_shot_spot:${s.id}`);
      if (go) return go;
    }
  }
  return undefined;
}

/** Plays to the robot's archetype. Reads only the ObservationView (own profile, others' visible traits). */
export const archetypePolicy: ScriptedPolicy = {
  id: "archetype",
  decide(view: ObservationView): Intent {
    const { self } = view;
    const p = self.profile;
    const opts = optionIndex(view);
    const hold: Intent = { action: "hold_position", params: {} };

    if (self.climb.inProgress && self.intent) return self.intent;
    if (self.climb.level > 0) return hold;

    // Endgame: climb when the time left gets close to what the best climb needs.
    if (view.phase === "endgame") {
      const climbs = view.options.filter((o) => o.intent.action === "climb");
      const best = climbs[climbs.length - 1];
      if (best && best.intent.action === "climb") {
        const tower = view.field.alliances[self.alliance].tower;
        const needS = dist(self.pose, tower) / p.speedEmptyMps + climbTimeForLevel(p, best.intent.params.level);
        if (view.matchRemainingS <= needS * CLIMB_START_FACTOR || self.fuelHeld === 0) return best.intent;
      }
    }

    // Pinned or stuck against an opponent: get out, toward where we are going next.
    const opponentContact = self.contact.withRobotId !== null && view.robots.some((r) => r.id === self.contact.withRobotId && !r.isPartner);
    if (opponentContact && (lastOwnEvent(view, "pinned") || lastOwnEvent(view, "contact_long") || lastOwnEvent(view, "no_progress"))) {
      if (p.shooterType === "none") {
        if (opts.has("disengage")) return opts.get("disengage")!; // back off before a G418 pin foul
      } else {
        const exit = self.fuelHeld > 0 ? "our_alliance" : "neutral";
        const escape = opts.get(`escape_spin:${exit}`) ?? opts.get(`escape_reverse:${exit}`);
        if (escape) return escape;
      }
    }

    // Defender: shadow the most dangerous opponent shooter.
    if (p.shooterType === "none") {
      const target = defendTarget(view);
      const defend = target ? opts.get(`defend:${target}`) : undefined;
      if (defend && !lastOwnEvent(view, "action_done", "disengage")) return defend;
      return opts.get("goto_zone:neutral") ?? hold;
    }

    // Feeder: pass to the partner that scores best, else score itself.
    if (p.archetype === "feeder_passer" && self.fuelHeld > 0) {
      const partner = view.robots
        .filter((r) => r.isPartner && r.fuelLevel !== "full" && r.traits.shooterType !== "none" && r.climbLevel === 0 && opts.has(`pass_to:robot=${r.id}`))
        .sort((a, b) => b.traits.lanes - a.traits.lanes || dist(self.pose, a.pose) - dist(self.pose, b.pose))[0];
      if (partner) return opts.get(`pass_to:robot=${partner.id}`)!;
    }

    // Zero-hopper turret: keep collecting; the engine fires what it picks up while the hub is in
    // range and active.
    if (p.canCollectWhileShooting && p.aimMethod === "turret" && view.hubs.ours.active) {
      const c = collectIntent(view, opts);
      if (c) return c;
    }

    const wantsToScore = self.fuelHeld > 0 && (self.fuelHeld >= p.capacity * SCORE_WHEN_FULL_FRACTION || !collectIntent(view, opts) || view.phase === "auto");
    if (wantsToScore) {
      const score = scoreIntent(view, opts);
      if (score) return score;
      if (p.shooterType !== "dumper" && opts.has("dump_unaligned") && view.hubs.ours.active) return opts.get("dump_unaligned")!;
    }

    const c = collectIntent(view, opts);
    if (c) {
      // Head for a free shot spot straight after a collect.
      const spot = scoringSpots(view)[0];
      if (spot && c.action === "collect") return { ...c, then: { action: "goto_shot_spot", params: { spotId: spot.id } } };
      return c;
    }
    if (self.fuelHeld > 0) {
      const score = scoreIntent(view, opts);
      if (score) return score;
    }
    return opts.get("hold_position") ?? hold;
  },
};

/** Policy used by `pnpm match` and other tools when none is named. */
export const DEFAULT_POLICY_ID = "archetype";

/** Registry of scripted policies by id. */
export const SCRIPTED_POLICIES: Record<string, ScriptedPolicy> = {
  [basicCyclePolicy.id]: basicCyclePolicy,
  [archetypePolicy.id]: archetypePolicy,
  [holdPolicy.id]: holdPolicy,
};
