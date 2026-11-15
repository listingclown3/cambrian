/**
 * Idle measurement (owner: P1) for the no-idle rule.
 *
 * A robot counts as idle in a tick when it is stationary (slower than the no-progress threshold,
 * triggers.noProgressMinMoveM per triggers.noProgressS) AND it has no active intent: no intent at
 * all, hold_position, or hold_fire_until_active (waiting, not doing). Robots climbing or hanging on
 * the tower, and robots being pinned, are excepted.
 */
import type { Config, MatchRobotSpec, MatchState, RobotState, ScriptedPolicy } from "../../../../contracts";
import { engine } from "../engine";
import { MatchRunner } from "./matchRunner";

const WAITING: ReadonlySet<string> = new Set(["hold_position", "hold_fire_until_active"]);

/** True when this robot is idle right now (see the file comment). */
export function isIdle(state: MatchState, robot: RobotState): boolean {
  if (robot.climb.inProgress || robot.climb.level > 0 || robot.contact.pinnedByRobotId !== null) return false;
  const { noProgressMinMoveM, noProgressS } = state.rules.triggers;
  if (Math.hypot(robot.velocity.vx, robot.velocity.vy) >= noProgressMinMoveM / noProgressS) return false;
  const step = robot.intent === null ? null : robot.intentStage === "then" && robot.intent.then ? robot.intent.then : robot.intent;
  return step === null || WAITING.has(step.action);
}

/** Idle seconds of one robot in one match. */
export interface RobotIdle {
  /** Robot id. */
  robotId: string;
  /** Archetype of the robot. */
  archetype: string;
  /** Total idle seconds in the match. */
  idleS: number;
  /** Longest continuous idle stretch, seconds. */
  longestIdleS: number;
}

/** Play one full scripted match and measure every robot's idle time. */
export function measureIdle(cfg: Config, seed: number, robots: MatchRobotSpec[], policy: ScriptedPolicy): RobotIdle[] {
  const runner = new MatchRunner(engine, cfg, seed, robots, { default: policy });
  const dtS = runner.state.rules.physics.dtS;
  const out = runner.state.robots.map((r) => ({ robotId: r.id, archetype: r.profile.archetype, idleS: 0, longestIdleS: 0, run: 0 }));
  while (!runner.finished) {
    const { state } = runner.tick();
    state.robots.forEach((r, i) => {
      const o = out[i]!;
      if (isIdle(state, r)) {
        o.idleS += dtS;
        o.run += dtS;
        o.longestIdleS = Math.max(o.longestIdleS, o.run);
      } else o.run = 0;
    });
  }
  return out.map(({ robotId, archetype, idleS, longestIdleS }) => ({
    robotId,
    archetype,
    idleS: Math.round(idleS * 100) / 100,
    longestIdleS: Math.round(longestIdleS * 100) / 100,
  }));
}
