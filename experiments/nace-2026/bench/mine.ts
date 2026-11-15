/**
 * pnpm nace:mine [-- --per-type 2] (owner: P3)
 * Find "sticky" decision points in the logged dev-seed matches (results/matches.json -> the
 * runs/<runId>/events.jsonl logs) and save each chosen one as a base Scenario.
 *
 * How: each logged match is replayed deterministically (same seed, same line-up, same scripted
 * policy); the replay's decision count is checked against the log's decision count so a replay
 * that drifted from its log is rejected. At every decision point the state is tested for these
 * sticky types (first match wins, in this order):
 *   hub_about_to_deactivate - holding >= 3 fuel, our hub active, it deactivates within 5 s
 *   contact_while_loaded    - in contact (or pinned) for >= 1 s while holding >= half capacity
 *   full_far_from_hub       - hopper >= 90% full and > 1.5 m beyond max shot range of our hub
 *   hub_inactive_loaded     - holding >= half capacity while our hub is inactive for >= 6 more s
 *   blocked_no_progress     - a path_blocked or no_progress trigger just fired for this robot
 *   endgame_climb_or_cycle  - endgame, 12-30 s left, a climb is offered, holding >= 3 fuel
 *   defended                - an opponent within 3 m is running `defend` on this robot
 * Auto (first 20 s) and robots that are climbing or hanging are skipped.
 * Selection per type is by a fixed rule (evenly spaced over (match, time) order, at most one per
 * match where possible), never by outcome. Options: curateOptions() in common.ts (6-8 options).
 *
 * Writes data/scenarios/mined.json.
 */
import { dist, getRobot, maskOptions, type EngineEvent, type Intent, type MatchState, type RobotId, type Snapshot } from "../../../src/contracts";
import { buildObservationView, engine } from "../../../src/world/worlds/rebuilt/engine";
import { robotsNeedingDecision } from "../../../src/world/worlds/rebuilt/exec";
import { loadConfig } from "../../../src/util/config";
import { simHash } from "../../../src/util/provenance";
import { scriptedPolicy, curateOptions, drawLineup, lineupKey, loadLeague, readJson, writeJson } from "./common";
import { readFileSync } from "node:fs";
import { repoPath } from "../../../src/util/config";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const perType = Number(arg("per-type", "2"));

export const STICKY_TYPES = ["hub_about_to_deactivate", "contact_while_loaded", "full_far_from_hub", "hub_inactive_loaded", "blocked_no_progress", "endgame_climb_or_cycle", "defended"] as const;
type StickyType = (typeof STICKY_TYPES)[number];

function stickyType(state: MatchState, robotId: RobotId, events: readonly EngineEvent[]): StickyType | null {
  const r = getRobot(state, robotId);
  if (state.timeS < state.rules.autoS + 1 || state.phase === "finished") return null;
  if (r.climb.inProgress || r.climb.level > 0) return null;
  const hub = state.hubs[r.alliance]!;
  const cap = r.profile.capacity;
  const remaining = state.rules.matchS - state.timeS;
  if (r.fuelHeld >= 3 && hub.active && state.phase !== "endgame" && hub.timeToShiftS <= 5 && hub.timeToShiftS < remaining - 1) return "hub_about_to_deactivate";
  if ((r.contact.withRobotId !== null && r.contact.contactS >= 1) || r.contact.pinnedByRobotId !== null) {
    if (cap > 0 && r.fuelHeld >= cap / 2) return "contact_while_loaded";
  }
  if (cap > 0 && r.fuelHeld >= 0.9 * cap && dist(r.pose, state.field.alliances[r.alliance].hub) > r.profile.maxShotDistanceM + 1.5) return "full_far_from_hub";
  if (cap > 0 && r.fuelHeld >= cap / 2 && !hub.active && state.phase === "shift" && hub.timeToShiftS >= 6) return "hub_inactive_loaded";
  if (events.some((e) => (e.kind === "path_blocked" || e.kind === "no_progress") && e.robotId === robotId)) return "blocked_no_progress";
  if (state.phase === "endgame" && remaining >= 12 && remaining <= 30 && r.fuelHeld >= 3 && maskOptions(r, state).some((o) => o.intent.action === "climb")) return "endgame_climb_or_cycle";
  if (state.robots.some((o) => o.alliance !== r.alliance && o.intent?.action === "defend" && (o.intent.params as { robotId?: string }).robotId === robotId && dist(o.pose, r.pose) <= 3)) return "defended";
  return null;
}

interface Candidate {
  matchIdx: number;
  tick: number;
  timeS: number;
  robotId: RobotId;
  type: StickyType;
}

/** Replay one logged match; call `visit` at every decision point (before the step). Returns the decision count. */
function replay(seed: number, k: number, visit: (state: MatchState, robotId: RobotId, events: readonly EngineEvent[]) => void): number {
  const state = engine.createMatch(cfg, seed, drawLineup(league, lineupKey(seed, k)));
  let lastEvents: EngineEvent[] = [];
  let decisions = 0;
  const since = new Map<RobotId, EngineEvent[]>();
  while (state.phase !== "finished") {
    const intents: Record<RobotId, Intent | undefined> = {};
    const need = robotsNeedingDecision(state, lastEvents);
    for (const robotId of need) visit(state, robotId, lastEvents);
    for (const robotId of need) {
      intents[robotId] = scriptedPolicy.decide(buildObservationView(state, robotId, since.get(robotId) ?? []));
      since.set(robotId, []);
      decisions += 1;
    }
    lastEvents = engine.step(state, intents, state.rules.physics.dtS).events;
    for (const robot of state.robots) {
      const seen = since.get(robot.id) ?? [];
      seen.push(...lastEvents);
      since.set(robot.id, seen.slice(-50));
    }
  }
  return decisions;
}

const cfg = loadConfig();
const league = loadLeague();
const matches = readJson<{ rows: { matchId: string; seed: number; lineupIndex: number; log: string; decisions: number }[]; simHash: string }>("results", "matches.json");
if (!matches) throw new Error("results/matches.json is missing: run pnpm nace:matches first");
if (matches.simHash !== simHash(cfg)) console.warn(`[mine] WARNING: matches were logged with simHash ${matches.simHash}, now ${simHash(cfg)}; re-run pnpm nace:matches`);

// Pass 1: candidates, with the replay checked against its log.
const candidates: Candidate[] = [];
const usable: boolean[] = [];
matches.rows.forEach((row, matchIdx) => {
  const logged = readFileSync(repoPath(...row.log.split("/")), "utf8").split("\n").filter((l) => l.includes('"type":"decision"')).length;
  const found: Candidate[] = [];
  const n = replay(row.seed, row.lineupIndex, (state, robotId, events) => {
    const type = stickyType(state, robotId, events);
    if (type) found.push({ matchIdx, tick: state.tick, timeS: state.timeS, robotId, type });
  });
  usable[matchIdx] = n === logged;
  if (n !== logged) console.warn(`[mine] ${row.matchId}: replay made ${n} decisions, log has ${logged}; skipped`);
  else candidates.push(...found);
});
console.log(`[mine] ${candidates.length} sticky candidates in ${usable.filter(Boolean).length} replay-verified matches: ${STICKY_TYPES.map((t) => `${t}=${candidates.filter((c) => c.type === t).length}`).join(" ")}`);

// Selection: per type, evenly spaced over (match, time) order, preferring distinct matches.
const chosen: Candidate[] = [];
for (const type of STICKY_TYPES) {
  const pool = candidates.filter((c) => c.type === type);
  // keep the first candidate of each (match, robot) run of consecutive decisions only
  const firsts = pool.filter((c, i) => i === 0 || !(pool[i - 1]!.matchIdx === c.matchIdx && pool[i - 1]!.robotId === c.robotId && c.timeS - pool[i - 1]!.timeS < 5));
  const byMatch = new Map<number, Candidate>();
  for (const c of firsts) if (!byMatch.has(c.matchIdx)) byMatch.set(c.matchIdx, c);
  const distinct = [...byMatch.values()];
  const source = distinct.length >= perType ? distinct : firsts;
  for (let j = 0; j < Math.min(perType, source.length); j++) chosen.push(source[Math.floor((j * source.length) / Math.min(perType, source.length))]!);
}

// Pass 2: snapshot the chosen decision points.
const bases: { id: string; stickyType: StickyType; matchId: string; seed: number; timeS: number; focusRobotId: string; snapshot: Snapshot; options: ReturnType<typeof curateOptions> }[] = [];
const byMatchIdx = new Map<number, Candidate[]>();
for (const c of chosen) byMatchIdx.set(c.matchIdx, [...(byMatchIdx.get(c.matchIdx) ?? []), c]);
for (const [matchIdx, list] of byMatchIdx) {
  const row = matches.rows[matchIdx]!;
  replay(row.seed, row.lineupIndex, (state, robotId) => {
    for (const c of list) {
      if (c.tick === state.tick && c.robotId === robotId) {
        const count = bases.filter((b) => b.stickyType === c.type).length + 1;
        bases.push({
          id: `${c.type}_${count}`,
          stickyType: c.type,
          matchId: row.matchId,
          seed: row.seed,
          timeS: state.timeS,
          focusRobotId: robotId,
          snapshot: engine.snapshot(state),
          options: curateOptions(state, robotId),
        });
      }
    }
  });
}
bases.sort((a, b) => a.id.localeCompare(b.id));
const file = writeJson({ generatedTs: new Date().toISOString(), simHash: simHash(cfg), seeds: { dev: [...new Set(bases.map((b) => b.seed))], eval: [] }, perType, bases }, "data", "scenarios", "mined.json");
for (const b of bases) console.log(`[mine] ${b.id}: ${b.matchId} t=${b.timeS.toFixed(1)} ${b.focusRobotId} options=${b.options.map((o) => o.label).join(",")}`);
console.log(`[mine] ${bases.length} base scenarios -> ${file}`);
