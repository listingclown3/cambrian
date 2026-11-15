/**
 * Renders ObservationViews as the text every provider sees (owner: P2).
 *
 * Whatever the wording, the same text goes to every provider being compared, and it uses only
 * what is in the view(s). Two parts:
 *
 *   renderSharedStateText(views)  what anyone on the alliance can see: clock, score, hubs, every
 *                                 robot in its OBSERVED form (traits a scout could see, no
 *                                 profile), loose fuel. Identical for all robots of an alliance,
 *                                 so one Drex call can answer for several robots at once.
 *   renderSelfText(view)          what one robot knows about itself (its own profile, fuel,
 *                                 alignment, intent, contact, climb, recent events). It goes in
 *                                 that robot's question instructions, never in the shared text,
 *                                 so no robot's private profile reaches another robot's question.
 *
 * renderStateText(view) = shared + self for a single robot (the one-question request).
 */
import { dist, type EngineEvent, type ObservationView, type ObservedRobot } from "../../contracts";

const fixed = (n: number, places = 1) => n.toFixed(places);

function robotLine(r: ObservedRobot): string {
  const t = r.traits;
  const parts = [
    `${r.id} (${r.alliance}, ${t.teamLabel})`,
    `at (${fixed(r.pose.x)}, ${fixed(r.pose.y)}) m`,
    `hopper ${r.fuelLevel}`,
    `${t.heightClass}, ${t.drivetrain} drive, ${t.shooterType} shooter${t.shootsOnMove ? " (shoots on the move)" : ""}, ${t.fitsUnderTrench ? "fits" : "does not fit"} under the trench`,
    r.apparentAction ? `appears to be doing: ${r.apparentAction}` : "idle",
  ];
  if (r.climbLevel > 0) parts.push(`hanging at tower level ${r.climbLevel}`);
  if (r.inContactWith) parts.push(`in contact with ${r.inContactWith}`);
  return `- ${parts.join("; ")}`;
}

function eventText(e: EngineEvent): string {
  return "robotId" in e && e.robotId ? `${e.kind} (${e.robotId})` : e.kind;
}

/** The part of the state every robot on one alliance sees identically. */
export function renderSharedStateText(views: readonly ObservationView[]): string {
  const first = views[0];
  if (!first) throw new Error("renderSharedStateText needs at least one view");
  const alliance = first.self.alliance;
  if (views.some((v) => v.self.alliance !== alliance || v.timeS !== first.timeS)) throw new Error("shared state text needs views of one alliance at one moment");
  const { hubs } = first;
  const hub = (h: typeof hubs.ours) => `${h.active ? "ACTIVE" : "inactive"}, changes in ${fixed(h.timeToShiftS)} s${h.warning ? " (deactivation warning)" : ""}`;

  // Every robot in its observed form: the union of what the views show about others. With one
  // view the deciding robot itself is described in its own part instead.
  const observed = new Map<string, ObservedRobot>();
  for (const v of views) for (const r of v.robots) if (!observed.has(r.id)) observed.set(r.id, r);
  const ours = [...observed.values()].filter((r) => r.alliance === alliance).sort((a, b) => a.id.localeCompare(b.id));
  const theirs = [...observed.values()].filter((r) => r.alliance !== alliance).sort((a, b) => a.id.localeCompare(b.id));

  const lines = [
    "FRC REBUILT 2026 match. Fuel scored in an active hub is worth 1 point; in an inactive hub, 0.",
    `Time ${fixed(first.timeS)} s, phase ${first.phase}${first.shiftIndex ? ` ${first.shiftIndex}` : ""}, ${fixed(first.matchRemainingS)} s left.`,
    `We are the ${alliance} alliance. Score: us ${first.score.ours}, them ${first.score.theirs}.`,
    `Our hub: ${hub(hubs.ours)}. Their hub: ${hub(hubs.theirs)}.`,
    "",
    `Our robots${views.length === 1 ? ` (besides ${first.self.id})` : ""}:`,
    ...ours.map(robotLine),
    "Opponent robots:",
    ...theirs.map(robotLine),
    "",
    `Loose fuel: ${Object.entries(first.fuel.byZone)
      .map(([zone, n]) => `${zone} ${n}`)
      .join(", ")}.`,
  ];
  if (first.fuel.piles.length > 0) lines.push(`Fuel piles: ${first.fuel.piles.map((p) => `${p.count} at (${fixed(p.pos.x)}, ${fixed(p.pos.y)})`).join(", ")}.`);
  return lines.join("\n");
}

/** What one robot knows about itself. Goes in that robot's own question only. */
export function renderSelfText(view: ObservationView, extra: readonly string[] = []): string {
  const { self } = view;
  const p = self.profile;
  const hubM = dist(self.pose, view.field.alliances[self.alliance].hub);
  const lines = [
    `Robot ${self.id} (${p.archetype}, ${p.shooterType} shooter, shot range ${fixed(p.minShotDistanceM)} to ${fixed(p.maxShotDistanceM)} m, holds up to ${p.capacity} fuel, climbs to level ${p.climbLevel}).`,
    `${self.id} is at (${fixed(self.pose.x)}, ${fixed(self.pose.y)}) m, ${fixed(hubM)} m from our hub; holding ${self.fuelHeld} of ${p.capacity} fuel; ${self.aligned ? "aligned" : "not aligned"} to our hub.`,
    self.intent ? `${self.id} is currently doing: ${self.intent.action}.` : `${self.id} is currently idle.`,
    `Distances from ${self.id}: ${view.robots.map((r) => `${r.id} ${fixed(dist(self.pose, r.pose))} m`).join(", ")}.`,
  ];
  if (self.contact.withRobotId) lines.push(`In contact with ${self.contact.withRobotId} for ${fixed(self.contact.contactS)} s${self.contact.pinnedByRobotId ? `; pinned by ${self.contact.pinnedByRobotId} for ${fixed(self.contact.pinS)} s` : ""}.`);
  if (self.climb.inProgress) lines.push(`Climbing to level ${self.climb.targetLevel}, ${fixed(self.climb.remainingS)} s left.`);
  else if (self.climb.level > 0) lines.push(`Hanging at tower level ${self.climb.level}.`);
  if (view.recentEvents.length > 0) lines.push(`Recent events: ${view.recentEvents.slice(-8).map(eventText).join(", ")}.`);
  lines.push(...extra);
  return lines.join("\n");
}

/** Full state text for a single robot: shared part, then its own part. */
export function renderStateText(view: ObservationView): string {
  return `${renderSharedStateText([view])}\n\n${renderSelfText(view)}`;
}
