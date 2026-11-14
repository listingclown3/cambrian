/** Slim match frames (owner: P4): static data once, a few KB of dynamic data per frame. */
import type { MatchState } from "../contracts";
import type { SlimFrame, SlimStatic } from "./protocol";

const MAX_BALLS = 80;

export function slimStatic(s: MatchState): SlimStatic {
  return { field: s.field, rules: s.rules, robots: s.robots.map((r) => ({ id: r.id, alliance: r.alliance, profile: r.profile })) };
}

export function slimFrame(s: MatchState): SlimFrame {
  return {
    timeS: s.timeS,
    phase: s.phase,
    shiftIndex: s.shiftIndex,
    hubs: s.hubs,
    score: { red: s.score.red.total, blue: s.score.blue.total },
    robots: s.robots.map((r) => ({ id: r.id, pose: r.pose, fuelHeld: r.fuelHeld })),
    fuel: { byZone: s.fuel.byZone, piles: s.fuel.piles, balls: s.fuel.balls.slice(0, MAX_BALLS) },
  };
}
