/**
 * Option curation and fact-rich descriptions for live play (owner: P2). Shared by every decider
 * and by P3's scenario requests, so the text a model sees is identical everywhere.
 *
 * PROMPT_VERSION names the exact prompt format (state text + option set + descriptions). It goes
 * into every results row derived from a DecisionRequest and into the response cache key, so
 * answers produced under different prompt versions are never mixed. Bump it whenever
 * stateText.ts, ask.ts or this file changes what a model is shown.
 */
import { climbTimeForLevel, dist, zoneCenter, type IntentOption, type IntentStep, type MatchRules, type ObservationView, type Vec2 } from "../../contracts";

export const PROMPT_VERSION = "p2-v2-curated10-facts";

/** The rule fields curation and facts read. Pass state.rules (public game rules). */
export type OptionRules = Pick<MatchRules, "endgameS" | "points" | "shotModel" | "triggers">;

/** Extra seconds before the endgame window in which climb options are offered (planner's rule). */
export const CLIMB_WINDOW_EXTRA_S = 5;

const SCORING_NOW = new Set(["shoot_now", "align_then_shoot", "dump_unaligned", "hold_fire_until_active"]);

/**
 * curateOptions(view, rules, max = 10): at most `max` of the robot's masked options, chosen by a
 * RELEVANCE FILTER BY OPTION TYPE, never by predicted value. Deterministic: the same view and
 * rules always give the same list, in the masked (master-list) order. Groups, in priority order
 * (a later group only fills what room is left):
 *   1. scoring the robot can do now: shoot_now / align_then_shoot / dump_unaligned /
 *      hold_fire_until_active, plus shoot_on_move toward the nearest shot spot
 *   2. contact: only when in contact: disengage, escape_spin and escape_reverse toward our
 *      alliance zone
 *   3. climb: only when matchRemainingS <= rules.endgameS + CLIMB_WINDOW_EXTRA_S: the highest and
 *      the lowest offered level (and keep-climbing / abort while a climb is under way)
 *   4. hold_position
 *   5. collect: the two collect / load options whose source zone has the most loose fuel (> 0)
 *   6. shot spots: goto_shot_spot for the two nearest spots the robot can score from
 *   7. defence: defend the nearest two opponents
 * When the masked list already has <= max options it is returned unchanged.
 */
export function curateOptions(view: ObservationView, rules: OptionRules, max = 10): IntentOption[] {
  const all = view.options;
  if (all.length <= max) return [...all];
  const self = view.self;
  const a = self.alliance;
  const by = (label: string) => all.find((o) => o.label === label);
  const picked: IntentOption[] = [];
  const add = (o: IntentOption | undefined) => {
    if (o && picked.length < max && !picked.includes(o)) picked.push(o);
  };
  const spots = view.field.shotSpots.filter((s) => s.alliance === a);
  const near = (p: Vec2) => dist(self.pose, p);

  // 1. scoring now
  for (const o of all) if (SCORING_NOW.has(o.intent.action) && !o.intent.then) add(o);
  const nearestSpot = [...spots].sort((x, y) => near(x.pos) - near(y.pos) || x.id.localeCompare(y.id))[0];
  if (nearestSpot) add(by(`shoot_on_move:spot=${nearestSpot.id}`));
  // 2. contact
  if (self.contact.withRobotId !== null) {
    add(by("disengage"));
    add(by("escape_spin:our_alliance"));
    add(by("escape_reverse:our_alliance"));
  }
  // 3. climb window
  if (view.matchRemainingS <= rules.endgameS + CLIMB_WINDOW_EXTRA_S || self.climb.inProgress) {
    const climbs = all.filter((o) => o.intent.action === "climb");
    add(climbs[climbs.length - 1]);
    add(climbs[0]);
    add(by("abort_climb"));
  }
  // 4. hold
  add(by("hold_position"));
  // 5. collect where the fuel is
  const fuel = view.fuel.byZone as Record<string, number>;
  const sources: [string, number][] = [
    ["collect:neutral", fuel.neutral ?? 0],
    ["collect:depot", fuel[`${a}_depot`] ?? 0],
    ["load_outpost", fuel[`${a}_outpost`] ?? 0],
    ["collect:local", fuel[`${a}_alliance`] ?? 0],
  ];
  for (const [label] of sources.filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 2)) add(by(label));
  // 6. nearest two shot spots it can score from
  const p = self.profile;
  const scorable = spots.filter((s) => s.distanceToHubM >= p.minShotDistanceM && s.distanceToHubM <= p.maxShotDistanceM);
  for (const s of scorable.sort((x, y) => near(x.pos) - near(y.pos) || x.id.localeCompare(y.id)).slice(0, 2)) add(by(`goto_shot_spot:${s.id}`));
  // 7. defend the nearest two opponents
  const opponents = view.robots.filter((r) => !r.isPartner).sort((x, y) => near(x.pose) - near(y.pose) || x.id.localeCompare(y.id));
  for (const r of opponents.slice(0, 2)) add(by(`defend:${r.id}`));

  const keep = new Set(picked);
  return all.filter((o) => keep.has(o));
}

// -- facts --

/** Own stationary accuracy at a distance, linearly interpolated from the profile's table. */
export function accuracyAt(view: ObservationView, distanceM: number): number {
  const t = view.self.profile.shotAccuracyByDistance;
  if (t.length === 0) return 0;
  if (distanceM <= t[0]!.distanceM) return t[0]!.accuracy;
  for (let i = 1; i < t.length; i++) {
    const lo = t[i - 1]!;
    const hi = t[i]!;
    if (distanceM <= hi.distanceM) return lo.accuracy + ((hi.accuracy - lo.accuracy) * (distanceM - lo.distanceM)) / Math.max(1e-9, hi.distanceM - lo.distanceM);
  }
  return t[t.length - 1]!.accuracy;
}

/** Own current top speed (interpolated between empty and full by hopper load). */
function speed(view: ObservationView): number {
  const p = view.self.profile;
  const f = p.capacity > 0 ? view.self.fuelHeld / p.capacity : 0;
  return p.speedEmptyMps + (p.speedFullMps - p.speedEmptyMps) * f;
}

function target(view: ObservationView, s: IntentStep): Vec2 | null {
  const a = view.self.alliance;
  const f = view.field;
  const spot = (id: string) => f.shotSpots.find((x) => x.alliance === a && x.id === id)?.pos ?? null;
  switch (s.action) {
    case "goto_zone":
      return zoneCenter(f, a, s.params.zone);
    case "goto_shot_spot":
    case "stage_fuel":
      return spot(s.params.spotId);
    case "collect":
      return s.params.source === "neutral" ? zoneCenter(f, a, "neutral") : s.params.source === "depot" ? zoneCenter(f, a, "depot") : null;
    case "load_outpost":
      return zoneCenter(f, a, "outpost");
    case "steal_fuel":
      return zoneCenter(f, a, s.params.zone);
    case "climb":
      return f.alliances[a].tower;
    case "shoot_on_move":
      return "spotId" in s.params ? spot(s.params.spotId) : null;
    case "defend":
    case "screen":
    case "protect_climber":
      return view.robots.find((r) => r.id === s.params.robotId)?.pose ?? null;
    default:
      return null;
  }
}

const r1 = (x: number) => (Math.round(x * 10) / 10).toString();

/**
 * The option's description plus compact, decision-relevant facts the robot itself knows,
 * computed from the ObservationView and the public rules only (never rollouts or answer keys):
 *   ~N pts   expected immediate points (fuel held x own accuracy at this distance x the active-hub
 *            fuel value; 0 when our hub is inactive; hold_fire_until_active: the points once it
 *            is active, with the wait in the time; for a climb, that level's tower points)
 *   ~T s     time estimate (travel = distance / own speed; align, spin-up and firing time; climb)
 *   risks    in contact, our hub about to deactivate, opponent in range
 * Example: "Shoot the held fuel at our hub right now from this position. ~6 pts, ~2 s; in contact: aim may break."
 */
export function describeWithFacts(option: IntentOption, view: ObservationView, rules: OptionRules): string {
  const s = option.intent;
  const self = view.self;
  const p = self.profile;
  const hubPos = view.field.alliances[self.alliance].hub;
  const hubD = dist(self.pose, hubPos);
  const active = view.hubs.ours.active;
  const facts: string[] = [];
  let pts: number | null = null;
  let timeS: number | null = null;

  const fireS = p.fireRatePerS > 0 ? self.fuelHeld / p.fireRatePerS : 0;
  const prepS = (aligned: boolean) => (aligned ? 0 : p.alignTimeS) + (self.spinUpReady ? 0 : p.spinUpS);
  const fuelPts = (acc: number) => (active ? self.fuelHeld * acc * rules.points.fuelActive : 0);
  const travel = (to: Vec2 | null) => (to ? dist(self.pose, to) / Math.max(0.1, speed(view)) : null);

  switch (s.action) {
    case "shoot_now":
      pts = fuelPts(accuracyAt(view, hubD));
      timeS = prepS(true) + fireS;
      break;
    case "align_then_shoot":
      pts = fuelPts(accuracyAt(view, hubD));
      timeS = prepS(self.aligned) + fireS;
      break;
    case "dump_unaligned":
      pts = fuelPts(accuracyAt(view, hubD) * rules.shotModel.dumpUnalignedAccuracyFactor);
      timeS = fireS;
      break;
    case "hold_fire_until_active":
      // Points once our hub is active; the wait is the time cost.
      pts = self.fuelHeld * accuracyAt(view, hubD) * rules.points.fuelActive;
      timeS = (active ? 0 : view.hubs.ours.timeToShiftS) + fireS;
      break;
    case "climb": {
      pts = rules.points.towerTeleop[s.params.level - 1] ?? null;
      const t = travel(target(view, s));
      timeS = (t ?? 0) + climbTimeForLevel(p, s.params.level);
      break;
    }
    default: {
      const t = travel(target(view, s));
      if (t !== null) timeS = t;
    }
  }
  if (pts !== null) facts.push(`~${Math.round(pts)} pts`);
  if (timeS !== null && Number.isFinite(timeS)) facts.push(`~${r1(timeS)} s`);

  const risks: string[] = [];
  const shooting = ["shoot_now", "align_then_shoot", "dump_unaligned", "shoot_on_move"].includes(s.action);
  const remedy = ["escape_spin", "escape_reverse", "disengage", "push_through"].includes(s.action);
  if (self.contact.withRobotId && !remedy) risks.push(shooting ? "in contact: aim may break" : `in contact with ${self.contact.withRobotId}`);
  if (shooting && active && (view.hubs.ours.warning || (timeS !== null && timeS > view.hubs.ours.timeToShiftS))) risks.push(`our hub deactivates in ${r1(view.hubs.ours.timeToShiftS)} s`);
  const nearestOpp = Math.min(Infinity, ...view.robots.filter((r) => !r.isPartner).map((r) => dist(self.pose, r.pose)));
  const fuelAction = shooting || ["hold_fire_until_active", "collect", "load_outpost", "stage_fuel", "pass_to"].includes(s.action);
  if (fuelAction && nearestOpp <= rules.triggers.opponentInRangeM) risks.push(`opponent within ${r1(nearestOpp)} m`);

  const tail = [facts.join(", "), risks.join("; ")].filter(Boolean).join("; ");
  return tail ? `${option.description} ${tail}.` : option.description;
}

/** The options a live request offers: curated (at most max) with fact-rich descriptions. Labels unchanged. */
export function liveOptions(view: ObservationView, rules: OptionRules, max = 10): { label: string; description: string }[] {
  return curateOptions(view, rules, max).map((o) => ({ label: o.label, description: describeWithFacts(o, view, rules) }));
}
