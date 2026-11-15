/**
 * Builds the static FieldLayout from config (owner: P1).
 * Blue elements come from config; red is the 180-degree rotation about the field centre.
 * Shot spots that would put the robot inside a field element (for example "hub_close", which is
 * nearer the hub than a robot's bumpers allow) are moved to the nearest position a robot centre
 * can actually reach, and distanceToHubM is measured from there.
 */
import { ALLIANCES, PhysicsParamsSchema, ROUTE_IDS, dist, type Alliance, type Config, type FieldLayout, type Vec2 } from "../../../../contracts";
import { getGrid, snapTarget } from "./nav";

export function buildFieldLayout(cfg: Config): FieldLayout {
  const raw = rawLayout(cfg);
  const grid = getGrid(raw, PhysicsParamsSchema.parse(cfg.physics));
  const shotSpots = raw.shotSpots.map((spot) => {
    const pos = snapTarget(grid, spot.pos, true);
    return { ...spot, pos, distanceToHubM: dist(pos, raw.alliances[spot.alliance].hub) };
  });
  return { ...raw, shotSpots };
}

function rawLayout(cfg: Config): FieldLayout {
  const lengthM = cfg.field.lengthM.value;
  const widthM = cfg.field.widthM.value;
  const depth = cfg.field.allianceZoneDepthM.value;
  const blue = cfg.field.blueElements.value;
  const laneY = cfg.field.blueLaneY.value;
  const half = cfg.field.laneLengthM.value / 2;

  const rotate = (p: Vec2): Vec2 => ({ x: lengthM - p.x, y: widthM - p.y });
  const forSide = (alliance: Alliance, p: Vec2): Vec2 => (alliance === "blue" ? { ...p } : rotate(p));

  const elements = (alliance: Alliance) => ({
    zone: alliance === "blue" ? { x0: 0, y0: 0, x1: depth, y1: widthM } : { x0: lengthM - depth, y0: 0, x1: lengthM, y1: widthM },
    hub: forSide(alliance, blue.hub),
    tower: forSide(alliance, blue.tower),
    depot: forSide(alliance, blue.depot),
    outpost: forSide(alliance, blue.outpost),
  });

  const alliances = { red: elements("red"), blue: elements("blue") };

  // "Tower post-up" spots: bumpers against either side of the alliance's own tower (derived from
  // the tower position and footprint; left/right as seen from behind the alliance wall).
  const sizes = cfg.field.elementSizes?.value;
  const r = cfg.physics.robotRadiusM;
  const towerSide = (sizes ? sizes.towerWidthM / 2 : r) + r;
  const towerPosts = [
    { id: "tower_post_left", pos: { x: blue.tower.x, y: blue.tower.y + towerSide }, description: "against the left side of our tower" },
    { id: "tower_post_right", pos: { x: blue.tower.x, y: blue.tower.y - towerSide }, description: "against the right side of our tower" },
  ];

  const shotSpots = ALLIANCES.flatMap((alliance) => [
    ...cfg.field.shotSpots.spots.map((spot) => {
      const pos = forSide(alliance, { x: blue.hub.x + spot.forwardFromHubM, y: blue.hub.y + spot.leftFromHubM });
      return { id: spot.id, alliance, pos, distanceToHubM: dist(pos, alliances[alliance].hub), description: spot.description };
    }),
    ...towerPosts.map((spot) => {
      const pos = forSide(alliance, spot.pos);
      return { id: spot.id, alliance, pos, distanceToHubM: dist(pos, alliances[alliance].hub), description: spot.description };
    }),
  ]);

  const lanes = ALLIANCES.flatMap((side) =>
    ROUTE_IDS.map((route) => ({
      route,
      side,
      allianceEnd: forSide(side, { x: depth - half, y: laneY[route] }),
      neutralEnd: forSide(side, { x: depth + half, y: laneY[route] }),
    })),
  );

  const elementSizes = cfg.field.elementSizes ? { ...cfg.field.elementSizes.value } : undefined;
  return {
    lengthM,
    widthM,
    alliances,
    neutral: { x0: depth, y0: 0, x1: lengthM - depth, y1: widthM },
    shotSpots,
    lanes,
    ...(elementSizes ? { elementSizes } : {}),
  };
}
