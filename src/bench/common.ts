/**
 * Shared helpers for the P3 benchmark scripts (owner: P3): league loading, line-ups, statistics,
 * scenario files, the fixed option-curation rule and the identical scenario request.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  dist,
  maskOptions,
  getRobot,
  RobotProfileSchema,
  ScenarioSchema,
  ScenarioFamilySchema,
  type Config,
  type DecisionRequest,
  type IntentOption,
  type MatchRobotSpec,
  type MatchState,
  type RobotProfile,
  type Scenario,
  type ScenarioFamily,
} from "../contracts";
import { buildActionRequest } from "../decide/ask";
import { buildObservationView, engine } from "../engine";
import { basicCyclePolicy } from "../exec";
import { repoPath } from "../util/config";
import { Rng, hashString } from "../util/rng";
import { z } from "zod";

// ── league ─────────────────────────────────────────────────────────────────

export const LeagueTeamSchema = z.object({
  profile: RobotProfileSchema,
  origin: z.enum(["real", "fabricated"]),
  /** Real teams: number of profile fields read from a document; fabricated: 0. */
  sourcedFieldCount: z.number().int().nonnegative(),
  /** Real teams: provenance per sourced field; fabricated: {}. */
  provenance: z.record(z.string(), z.unknown()),
  /** Real teams: archetype classification from teams_from_docs.json when present. */
  classifiedArchetype: z.unknown().optional(),
});
export type LeagueTeam = z.infer<typeof LeagueTeamSchema>;
export const LeagueFileSchema = z.object({
  generatedTs: z.string(),
  note: z.string(),
  seed: z.number().int(),
  teams: z.array(LeagueTeamSchema),
});
export type LeagueFile = z.infer<typeof LeagueFileSchema>;

export function loadLeague(): LeagueFile {
  return LeagueFileSchema.parse(JSON.parse(readFileSync(repoPath("data", "league", "league.json"), "utf8")));
}

/** Six distinct league teams for one match, drawn deterministically from `key`. */
export function drawLineup(league: LeagueFile, key: string, controllers: { blue: string; red: string } = { blue: "basic_cycle", red: "basic_cycle" }): MatchRobotSpec[] {
  const rng = Rng.fromSeed(hashString(key));
  const pool = league.teams.map((t) => t.profile);
  const picked: RobotProfile[] = [];
  while (picked.length < 6) {
    const p = rng.pick(pool);
    if (!picked.includes(p)) picked.push(p);
  }
  return picked.map((profile, i) => ({ profile, alliance: i < 3 ? "blue" : "red", controllerId: i < 3 ? controllers.blue : controllers.red }));
}

/** Line-up key used by matches.ts and mine.ts. */
export const lineupKey = (seed: number, k: number) => `matches:${seed}:${k}`;

// ── statistics ─────────────────────────────────────────────────────────────

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Two-sided 95% Student t critical values by degrees of freedom (1..30); 1.96 beyond. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

/** Half-width of the 95% confidence interval of the mean (Student t). 0 when n < 2. */
export function ci95(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const t = n - 1 <= 30 ? T95[n - 2]! : 1.96;
  return (t * sd) / Math.sqrt(n);
}

export function pct(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export const round = (v: number, places = 3) => (Number.isFinite(v) ? Number(v.toFixed(places)) : null);

// ── files ──────────────────────────────────────────────────────────────────

export function readJson<T = any>(...parts: string[]): T | null {
  const file = repoPath(...parts);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

export function writeJson(value: unknown, ...parts: string[]): string {
  const file = repoPath(...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + "\n");
  return file;
}

export const ScenarioSetSchema = z.object({
  generatedTs: z.string(),
  simHash: z.string(),
  note: z.string(),
  families: z.array(ScenarioFamilySchema),
  scenarios: z.array(ScenarioSchema),
});
export type ScenarioSet = z.infer<typeof ScenarioSetSchema>;

export function loadScenarioSet(file = "scenarios.json"): ScenarioSet {
  const raw = readJson("data", "scenarios", file);
  if (!raw) throw new Error(`data/scenarios/${file} is missing; run the earlier pipeline steps first`);
  return ScenarioSetSchema.parse(raw);
}

export type { Scenario, ScenarioFamily };

// ── option curation (fixed rule; never looks at outcomes) ──────────────────

/**
 * Curate 6 to 8 options from the full mask for `robotId` in `state`, by a fixed priority rule:
 *   1. the scripted policy's own choice (the "default play")
 *   2. one shot: shoot_now or align_then_shoot (if offered)
 *   3. hold_fire_until_active
 *   4. collect:neutral (else collect:local, collect:depot)
 *   5. the nearest own-alliance goto_shot_spot within this robot's shot range
 *   6. the highest climb offered
 *   7. contact exits: escape_spin:neutral, disengage (if offered)
 *   8. defend the nearest opponent
 *   9. stage_fuel at the nearest spot, dump_unaligned, load_outpost, goto_zone:neutral, hold_position
 * Duplicates are skipped; the list stops at 8. Output keeps master-list (mask) order so the
 * scripted pick is not always first.
 */
export function curateOptions(state: MatchState, robotId: string): IntentOption[] {
  const robot = getRobot(state, robotId);
  const all = maskOptions(robot, state);
  const by = (label: string) => all.find((o) => o.label === label);
  const view = buildObservationView(state, robotId);
  const scripted = basicCyclePolicy.decide(view);
  const scriptedLabel = all.find((o) => JSON.stringify(o.intent) === JSON.stringify(scripted))?.label;
  const spotsInRange = state.field.shotSpots
    .filter((s) => s.alliance === robot.alliance)
    .filter((s) => {
      const d = dist(s.pos, state.field.alliances[robot.alliance].hub);
      return d >= robot.profile.minShotDistanceM && d <= robot.profile.maxShotDistanceM;
    })
    .sort((a, b) => dist(robot.pose, a.pos) - dist(robot.pose, b.pos));
  const spotsAll = state.field.shotSpots.filter((s) => s.alliance === robot.alliance).sort((a, b) => dist(robot.pose, a.pos) - dist(robot.pose, b.pos));
  const opponents = state.robots.filter((r) => r.alliance !== robot.alliance).sort((a, b) => dist(robot.pose, a.pose) - dist(robot.pose, b.pose));
  const climbs = all.filter((o) => o.intent.action === "climb");
  const wanted: (string | undefined)[] = [
    scriptedLabel,
    by("shoot_now")?.label ?? by("align_then_shoot")?.label,
    by("hold_fire_until_active")?.label,
    by("collect:neutral")?.label ?? by("collect:local")?.label ?? by("collect:depot")?.label,
    spotsInRange[0] ? by(`goto_shot_spot:${spotsInRange[0].id}`)?.label : undefined,
    state.phase === "endgame" ? climbs[climbs.length - 1]?.label : undefined,
    by("escape_spin:neutral")?.label,
    by("disengage")?.label,
    opponents[0] ? by(`defend:${opponents[0].id}`)?.label : undefined,
    spotsAll[0] ? by(`stage_fuel:${spotsAll[0].id}`)?.label : undefined,
    by("dump_unaligned")?.label,
    by("load_outpost")?.label,
    by("goto_zone:neutral")?.label,
    by("hold_position")?.label,
    // fillers, only used when fewer than 6 of the above are offered
    spotsAll[1] ? by(`goto_shot_spot:${spotsAll[1].id}`)?.label : undefined,
    by("goto_zone:our_alliance")?.label,
    all.find((o) => o.intent.action === "block_lane")?.label,
    all.find((o) => o.intent.action === "screen")?.label,
    by("goto_zone:their_alliance")?.label,
  ];
  const chosen = new Set<string>();
  const primary = wanted.length - 5;
  wanted.forEach((l, i) => {
    if (!l || chosen.has(l) || chosen.size >= 8) return;
    if (i >= primary && chosen.size >= 6) return;
    chosen.add(l);
  });
  return all.filter((o) => chosen.has(o.label));
}

/**
 * Rule fixed at 1:05 PM, before any re-scoring: a team would not consider climbing before the
 * end game, so climb options are not part of a scenario's choice set unless the snapshot is in
 * the endgame phase. Applied to the answer key (and to option curation for new scenarios).
 * Reason: with a 20 s horizon a pre-endgame climb banks tower points inside the horizon while its
 * real cost (no more scoring for the rest of the match) falls outside it.
 */
export function isExcludedOption(s: Pick<Scenario, "snapshot">, label: string): boolean {
  return s.snapshot.state.phase !== "endgame" && label.startsWith("climb");
}

/** Recompute best and ambiguous from values (best = highest mean; ambiguous = CI overlap with the runner-up). */
export function keyFromValues(values: Record<string, { mean: number; ci95: number; n: number }>): { values: typeof values; best: string; ambiguous: boolean } {
  const ranked = Object.entries(values).sort((a, b) => b[1].mean - a[1].mean);
  const [best, second] = ranked;
  return { values, best: best![0], ambiguous: second ? best![1].mean - best![1].ci95 <= second[1].mean + second[1].ci95 : false };
}

/** The scripted policy's pick for the focus robot, as a label of `options` (or null if not offered). */
export function scriptedLabelFor(state: MatchState, robotId: string, options: readonly IntentOption[]): string | null {
  const intent = basicCyclePolicy.decide(buildObservationView(state, robotId));
  return options.find((o) => JSON.stringify(o.intent) === JSON.stringify(intent))?.label ?? null;
}

// ── the identical scenario request ─────────────────────────────────────────

/** Fixed request seed for scenario questions, so every decider gets byte-identical requests. */
export const SCENARIO_REQUEST_SEED = 7;

/**
 * The request every decider gets for a scenario: the focus robot's observation view of the
 * snapshot, with its option list replaced by the scenario's curated options, built by
 * src/decide/ask.ts. Deciders never see the answer key.
 */
export function scenarioRequest(s: Scenario): DecisionRequest {
  const state = engine.restore(s.snapshot);
  const view = { ...buildObservationView(state, s.focusRobotId), options: s.options };
  return buildActionRequest(view, SCENARIO_REQUEST_SEED, "offline");
}

/** Same request with option labels replaced by opt_01, opt_02, ... (descriptions unchanged). */
export function anonymize(req: DecisionRequest): { request: DecisionRequest; toReal: Map<string, string> } {
  const toReal = new Map<string, string>();
  const questions = req.questions.map((q) => ({
    ...q,
    options: q.options?.map((o, i) => {
      const anon = `opt_${String(i + 1).padStart(2, "0")}`;
      toReal.set(anon, o.label);
      return { label: anon, description: o.description };
    }),
  }));
  return { request: { ...req, questions }, toReal };
}

export function cfgSubset(cfg: Config) {
  return { seeds: cfg.seeds, answerKey: cfg.answerKey, league: cfg.league, realtimeLatencyCharging: cfg.realtimeLatencyCharging, providers: cfg.providers, pricesPerMTokUsd: cfg.pricesPerMTokUsd };
}
