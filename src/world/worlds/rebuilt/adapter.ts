/**
 * FRC REBUILT 2026 as a bring-your-own world (Tier 2: the sim models a real game).
 * Wraps the existing engine and match runner; a "policy" is a pair of scripted policy ids.
 *
 * Known world bug kept on purpose: the engine checks shot distance only and does not enforce
 * G407 (launch only from your own alliance zone). See notes/decisions.md, C.
 */
import type { Config, ScriptedPolicy } from "../../../contracts";
import { simHash } from "../../../util/provenance";
import type { EpisodeOutcome, WorldAdapter } from "../../types";
import { engine } from "./engine";
import { MatchRunner, SCRIPTED_POLICIES, demoRobots } from "./exec";

export interface RebuiltPolicy {
  /** Scripted policy id for blue (the side being optimised). */
  blue: string;
  /** Scripted policy id for red (the opponent). */
  red: string;
}

const policyById = (id: string): ScriptedPolicy => {
  const p = SCRIPTED_POLICIES[id];
  if (!p) throw new Error(`unknown REBUILT policy ${id}; known: ${Object.keys(SCRIPTED_POLICIES).join(", ")}`);
  return p;
};

export function rebuiltWorld(cfg: Config): WorldAdapter<RebuiltPolicy> {
  return {
    id: "rebuilt",
    title: "FRC REBUILT 2026 (Team 488 simulator, forked)",
    tier: "reality",
    defaultRulesMode: "flag",
    metrics: [
      { id: "margin", description: "blue total score minus red total score", direction: "max", unit: "points" },
      { id: "blue_total", description: "blue total score", direction: "max", unit: "points" },
      { id: "fouls_on_blue", description: "fouls called on blue", direction: "min", unit: "fouls" },
    ],
    versionHash: () => simHash(cfg),
    runEpisode(seed: number, policy: RebuiltPolicy): EpisodeOutcome {
      const blue = policyById(policy.blue);
      const red = policyById(policy.red);
      const both: ScriptedPolicy = { id: `${blue.id}|${red.id}`, decide: (v) => (v.self.alliance === "blue" ? blue : red).decide(v) };
      const { state } = new MatchRunner(engine, cfg, seed, demoRobots(cfg, { blue: blue.id, red: red.id }), { default: both }).runToEnd();
      const foulsOnBlue = state.fouls.filter((f) => f.byAlliance === "blue").length;
      return {
        seed,
        metrics: { margin: state.score.blue.total - state.score.red.total, blue_total: state.score.blue.total, fouls_on_blue: foulsOnBlue },
        end: { blueTotal: state.score.blue.total, redTotal: state.score.red.total, timeS: state.timeS },
      };
    },
  };
}
