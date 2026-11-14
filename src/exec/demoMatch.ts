/**
 * A ready-made 3v3 line-up for demos, smoke tests and unit tests (owner: P1).
 * Uses the midpoint robot of six archetypes straight from the config templates, so it needs no
 * league data on disk.
 */
import { profileFromTemplate, type Archetype, type Config, type MatchRobotSpec } from "../contracts";

const BLUE: Archetype[] = ["turret_sotm", "drum_fixed", "feeder_passer"];
const RED: Archetype[] = ["multilane_fixed", "dumper", "big_hopper_hauler"];

/** Six robots (three per alliance), each the midpoint of its archetype template. */
export function demoRobots(cfg: Config, controllers: { blue: string; red: string } = { blue: "basic_cycle", red: "basic_cycle" }): MatchRobotSpec[] {
  const make = (archetype: Archetype, alliance: "blue" | "red", n: number): MatchRobotSpec => ({
    profile: profileFromTemplate(
      archetype,
      cfg.archetypes.templates[archetype],
      { id: `demo_${alliance}_${n}`, teamLabel: `Demo ${alliance} ${n}` },
      cfg.game.fuelMassKg.value,
    ),
    alliance,
    controllerId: controllers[alliance],
  });
  return [...BLUE.map((a, i) => make(a, "blue", i + 1)), ...RED.map((a, i) => make(a, "red", i + 1))];
}
