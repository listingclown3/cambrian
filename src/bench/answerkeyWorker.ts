/**
 * tinypool worker for answerkey.ts (owner: P3): runs rollouts for one (scenario, option) batch.
 * The focus robot starts with the option's intent; every other robot (and the focus robot once
 * its option completes) follows the default scripted policy (DEFAULT_POLICY_ID).
 */
import { readFileSync } from "node:fs";
import type { Scenario } from "../contracts";
import { engine } from "../engine";
import { DEFAULT_POLICY_ID, SCRIPTED_POLICIES } from "../exec/policies";

const policy = SCRIPTED_POLICIES[DEFAULT_POLICY_ID]!;

const cache = new Map<string, Scenario[]>();

export interface RolloutTask {
  file: string;
  scenarioIdx: number;
  label: string;
  seeds: number[];
  horizonS: number;
}

export default function run(task: RolloutTask): { margins: number[]; ms: number } {
  let list = cache.get(task.file);
  if (!list) {
    list = (JSON.parse(readFileSync(task.file, "utf8")) as { scenarios: Scenario[] }).scenarios;
    cache.set(task.file, list);
  }
  const s = list[task.scenarioIdx]!;
  const option = s.options.find((o) => o.label === task.label)!;
  const t0 = performance.now();
  const margins = task.seeds.map((seed) => {
    const r = engine.rollout(s.snapshot, { [s.focusRobotId]: option.intent }, task.horizonS, seed, { default: policy });
    return r.pointsFor - r.pointsAgainst;
  });
  return { margins, ms: performance.now() - t0 };
}
