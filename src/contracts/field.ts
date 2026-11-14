/**
 * Field geometry contract: zones, routes, lanes, shot spots.
 *
 * The layout is static per match and is embedded in MatchState so that snapshots are self-contained.
 * All numbers come from config/default.json (`field` section) and are TODO_VERIFY_AGAINST_MANUAL.
 */
import { z } from "zod";
import { AllianceSchema, RectSchema, Vec2Schema, otherAlliance, rectCenter, type Alliance, type Vec2 } from "./common";

/**
 * Alliance-relative zone names used in action parameters.
 * "our"/"their" are always from the acting robot's point of view; outpost, depot and tower are
 * the acting robot's own alliance's elements.
 */
export const ZoneSchema = z.enum(["our_alliance", "neutral", "their_alliance", "outpost", "depot", "tower"]);
export type Zone = z.infer<typeof ZoneSchema>;
export const ZONES = ZoneSchema.options;

/**
 * Absolute (colour-named) floor zones used for fuel bookkeeping in MatchState.
 * Every loose fuel ball belongs to exactly one of these.
 */
export const FieldZoneIdSchema = z.enum([
  "blue_alliance",
  "neutral",
  "red_alliance",
  "blue_depot",
  "red_depot",
  "blue_outpost",
  "red_outpost",
]);
export type FieldZoneId = z.infer<typeof FieldZoneIdSchema>;
export const FIELD_ZONE_IDS = FieldZoneIdSchema.options;

/**
 * The four ways across an alliance-zone/neutral-zone boundary.
 * "left"/"right" are from the point of view of a driver standing behind their own alliance wall.
 * Trenches are low (only robots with fitsUnderTrench may use them); bumps are driven over.
 */
export const RouteIdSchema = z.enum(["left_trench", "right_trench", "left_bump", "right_bump"]);
export type RouteId = z.infer<typeof RouteIdSchema>;
export const ROUTE_IDS = RouteIdSchema.options;

/** True for the two trench routes. */
export function isTrench(route: RouteId): boolean {
  return route === "left_trench" || route === "right_trench";
}

/**
 * A lane that can be blocked: one of the four routes on either our side or their side of the field.
 * "our_left_trench" is the left trench next to the acting robot's own alliance zone.
 */
export const LaneIdSchema = z.enum([
  "our_left_trench",
  "our_right_trench",
  "our_left_bump",
  "our_right_bump",
  "their_left_trench",
  "their_right_trench",
  "their_left_bump",
  "their_right_bump",
]);
export type LaneId = z.infer<typeof LaneIdSchema>;
export const LANE_IDS = LaneIdSchema.options;

/** Split a LaneId into which side it is on (relative to the actor) and which route it is. */
export function parseLaneId(lane: LaneId): { side: "our" | "their"; route: RouteId } {
  const side = lane.startsWith("our_") ? "our" : "their";
  return { side, route: lane.slice(side.length + 1) as RouteId };
}

/** Coarse field-relative direction used by push_through. Relative to the acting robot's alliance. */
export const DirectionSchema = z.enum(["toward_our_alliance", "toward_their_alliance", "toward_left_wall", "toward_right_wall"]);
export type Direction = z.infer<typeof DirectionSchema>;
export const DIRECTIONS = DirectionSchema.options;

/** A named place to shoot from or stage fuel at. Belongs to one alliance. */
export const ShotSpotSchema = z.object({
  /** Stable id, unique per alliance (for example "hub_front"). Used verbatim in option labels. */
  id: z.string().min(1),
  /** The alliance whose hub this spot serves. */
  alliance: AllianceSchema,
  /** Position on the field, metres. */
  pos: Vec2Schema,
  /** Straight-line distance from this spot to the alliance's hub centre, metres. */
  distanceToHubM: z.number().nonnegative(),
  /** Short plain-English description used in option descriptions. */
  description: z.string(),
});
export type ShotSpot = z.infer<typeof ShotSpotSchema>;

/** One physical trench or bump crossing. */
export const LaneSchema = z.object({
  /** Which of the four routes this is. */
  route: RouteIdSchema,
  /** The alliance whose zone this crossing borders. */
  side: AllianceSchema,
  /** End of the crossing inside the alliance zone, metres. */
  allianceEnd: Vec2Schema,
  /** End of the crossing inside the neutral zone, metres. */
  neutralEnd: Vec2Schema,
});
export type Lane = z.infer<typeof LaneSchema>;

/** Field elements belonging to one alliance. */
export const AllianceFieldSchema = z.object({
  /** The alliance zone floor area. */
  zone: RectSchema,
  /** Hub centre. */
  hub: Vec2Schema,
  /** Tower (climb) position. */
  tower: Vec2Schema,
  /** Depot (floor fuel inside the alliance zone) position. */
  depot: Vec2Schema,
  /** Outpost (human-player fuel feed) position. */
  outpost: Vec2Schema,
});
export type AllianceField = z.infer<typeof AllianceFieldSchema>;

/** Complete static field description. */
export const FieldLayoutSchema = z.object({
  /** Field length along x, metres. */
  lengthM: z.number().positive(),
  /** Field width along y, metres. */
  widthM: z.number().positive(),
  /** Per-alliance elements. */
  alliances: z.record(AllianceSchema, AllianceFieldSchema),
  /** The neutral zone floor area between the two alliance zones. */
  neutral: RectSchema,
  /** All shot/staging spots for both alliances. */
  shotSpots: z.array(ShotSpotSchema),
  /** All eight trench/bump crossings (four per alliance side). */
  lanes: z.array(LaneSchema),
});
export type FieldLayout = z.infer<typeof FieldLayoutSchema>;

/** Field position of an alliance-relative zone, from `alliance`'s point of view. */
export function zoneCenter(field: FieldLayout, alliance: Alliance, zone: Zone): Vec2 {
  const ours = field.alliances[alliance];
  switch (zone) {
    case "our_alliance":
      return rectCenter(ours.zone);
    case "their_alliance":
      return rectCenter(field.alliances[otherAlliance(alliance)].zone);
    case "neutral":
      return rectCenter(field.neutral);
    case "outpost":
      return ours.outpost;
    case "depot":
      return ours.depot;
    case "tower":
      return ours.tower;
  }
}

/** The absolute floor zone that fuel in an alliance-relative zone is booked under. */
export function fieldZoneOf(alliance: Alliance, zone: Zone): FieldZoneId {
  const other = otherAlliance(alliance);
  switch (zone) {
    case "our_alliance":
    case "tower":
      return `${alliance}_alliance`;
    case "their_alliance":
      return `${other}_alliance`;
    case "neutral":
      return "neutral";
    case "outpost":
      return `${alliance}_outpost`;
    case "depot":
      return `${alliance}_depot`;
  }
}

/** The absolute floor zone containing a point (alliance zones and neutral only). */
export function floorZoneAt(field: FieldLayout, p: Vec2): FieldZoneId {
  if (p.x <= field.alliances.blue.zone.x1) return "blue_alliance";
  if (p.x >= field.alliances.red.zone.x0) return "red_alliance";
  return "neutral";
}

/** Find the physical lane for an actor-relative LaneId. */
export function findLane(field: FieldLayout, alliance: Alliance, lane: LaneId): Lane | undefined {
  const { side, route } = parseLaneId(lane);
  const sideAlliance = side === "our" ? alliance : otherAlliance(alliance);
  return field.lanes.find((l) => l.side === sideAlliance && l.route === route);
}

/** Unit vector for a Direction from `alliance`'s point of view. Blue drives toward +x, red toward -x. */
export function directionVector(alliance: Alliance, d: Direction): Vec2 {
  const forward = alliance === "blue" ? 1 : -1;
  switch (d) {
    case "toward_their_alliance":
      return { x: forward, y: 0 };
    case "toward_our_alliance":
      return { x: -forward, y: 0 };
    case "toward_left_wall":
      return { x: 0, y: forward };
    case "toward_right_wall":
      return { x: 0, y: -forward };
  }
}
