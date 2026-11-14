/**
 * Renders an ObservationView as the text every provider sees (owner: P2).
 *
 * STUB: a compact, factual rendering. P2 owns the wording. Whatever it becomes, the same text
 * must go to every provider being compared, and it may only use what is in the view.
 */
import { dist, type ObservationView, type ObservedRobot } from "../contracts";

const fixed = (n: number, places = 1) => n.toFixed(places);

function robotLine(view: ObservationView, r: ObservedRobot): string {
  const t = r.traits;
  const parts = [
    `${r.id} (${r.isPartner ? "partner" : "opponent"}, ${t.teamLabel})`,
    `at (${fixed(r.pose.x)}, ${fixed(r.pose.y)}) m, ${fixed(dist(view.self.pose, r.pose))} m from us`,
    `hopper ${r.fuelLevel}`,
    `${t.heightClass}, ${t.drivetrain} drive, ${t.shooterType} shooter`,
    r.apparentAction ? `appears to be doing: ${r.apparentAction}` : "idle",
  ];
  if (r.climbLevel > 0) parts.push(`hanging at tower level ${r.climbLevel}`);
  if (r.inContactWith) parts.push(`in contact with ${r.inContactWith}`);
  return `- ${parts.join("; ")}`;
}

export function renderStateText(view: ObservationView): string {
  const { self, hubs } = view;
  const hub = (h: typeof hubs.ours) => `${h.active ? "ACTIVE" : "inactive"}, changes in ${fixed(h.timeToShiftS)} s${h.warning ? " (deactivation warning)" : ""}`;
  const hubM = dist(self.pose, view.field.alliances[self.alliance].hub);
  const lines = [
    "FRC REBUILT 2026 match. Fuel scored in an active hub is worth 1 point; in an inactive hub, 0.",
    `Time ${fixed(view.timeS)} s, phase ${view.phase}${view.shiftIndex ? ` ${view.shiftIndex}` : ""}, ${fixed(view.matchRemainingS)} s left.`,
    `Score: us ${view.score.ours}, them ${view.score.theirs}.`,
    `Our hub: ${hub(hubs.ours)}. Their hub: ${hub(hubs.theirs)}.`,
    "",
    `You are robot ${self.id} on the ${self.alliance} alliance (${self.profile.archetype}).`,
    `Position (${fixed(self.pose.x)}, ${fixed(self.pose.y)}) m, ${fixed(hubM)} m from our hub; holding ${self.fuelHeld} of ${self.profile.capacity} fuel; ${self.aligned ? "aligned" : "not aligned"} to our hub.`,
    self.intent ? `Currently doing: ${self.intent.action}.` : "Currently idle.",
    "",
    "Other robots:",
    ...view.robots.map((r) => robotLine(view, r)),
    "",
    `Loose fuel: ${Object.entries(view.fuel.byZone)
      .map(([zone, n]) => `${zone} ${n}`)
      .join(", ")}.`,
  ];
  if (view.fuel.piles.length > 0) lines.push(`Fuel piles: ${view.fuel.piles.map((p) => `${p.count} at (${fixed(p.pos.x)}, ${fixed(p.pos.y)})`).join(", ")}.`);
  if (view.recentEvents.length > 0) lines.push(`Recent events: ${view.recentEvents.slice(-8).map((e) => e.kind).join(", ")}.`);
  return lines.join("\n");
}
