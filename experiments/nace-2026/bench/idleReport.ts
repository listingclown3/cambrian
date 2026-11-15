/**
 * Idle report (owner: P1): idle seconds per robot per match on the dev seeds, BEFORE (the policy
 * frozen at commit 6616170, id "archetype_v1") and AFTER (the no-idle role table, "archetype").
 *
 *   pnpm nace:idle        -> results/idle_report.json
 */
import { writeFileSync } from "node:fs";
import { loadConfig, repoPath } from "../../../src/util/config";
import { demoRobots } from "../../../src/world/worlds/rebuilt/exec/demoMatch";
import { measureIdle, type RobotIdle } from "../../../src/world/worlds/rebuilt/exec/idle";
import { archetypePolicy, archetypeV1Policy } from "../../../src/world/worlds/rebuilt/exec/policies";

const cfg = loadConfig();
const seeds = cfg.seeds.dev;
const robots = demoRobots(cfg);

function run(policyId: string, policy: typeof archetypePolicy) {
  const matches = seeds.map((seed) => ({ seed, robots: measureIdle(cfg, seed, robots, policy) }));
  const all: RobotIdle[] = matches.flatMap((m) => m.robots);
  const mean = all.reduce((a, r) => a + r.idleS, 0) / Math.max(1, all.length);
  return {
    policy: policyId,
    meanIdleSPerRobotPerMatch: Math.round(mean * 100) / 100,
    maxIdleSPerRobotPerMatch: Math.max(...all.map((r) => r.idleS)),
    longestIdleStretchS: Math.max(...all.map((r) => r.longestIdleS)),
    matches,
  };
}

const before = run("archetype_v1 (frozen at 6616170)", archetypeV1Policy);
const after = run("archetype (no-idle role table)", archetypePolicy);
const report = {
  experiment: "idle_report",
  definition:
    "idle = stationary (speed below triggers.noProgressMinMoveM / triggers.noProgressS) with no active intent (none, hold_position or hold_fire_until_active); climbing, hanging and pinned robots excepted",
  lineup: "demoRobots (3v3 archetype midpoints)",
  seeds,
  maxIdleS: cfg.triggers.maxIdleS ?? null,
  before,
  after,
};
const file = repoPath("results", "idle_report.json");
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`before: mean ${before.meanIdleSPerRobotPerMatch} s idle per robot per match, longest stretch ${before.longestIdleStretchS} s`);
console.log(`after:  mean ${after.meanIdleSPerRobotPerMatch} s idle per robot per match, longest stretch ${after.longestIdleStretchS} s`);
console.log(`wrote ${file}`);
