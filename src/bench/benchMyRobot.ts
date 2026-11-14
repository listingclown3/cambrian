/**
 * pnpm bench:myrobot [-- --seeds N] [--decider scripted|drex] [--drex-seeds N] [--budget-s S]
 *
 * Plays the user's robot (data/profiles/my_robot.json) with two fixed partner robots against each
 * of the nine archetypes (three midpoint robots of that archetype) on the first N eval seeds, and
 * writes results/myrobot.json. Each decider (scripted, drex) is reported separately and never mixed.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { ARCHETYPES, RobotProfileSchema, profileFromTemplate, type Alliance, type Archetype, type Config, type EngineEvent, type MatchRobotSpec, type MatchState, type RobotProfile } from "../contracts";
import { AgentController } from "../decide/controller";
import { getProviderBySpec } from "../decide/registry";
import { engine } from "../engine";
import { basicCyclePolicy } from "../exec";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

export type Decider = "scripted" | "drex";
const ME = "B1";

export interface MatchMetrics {
  archetype: Archetype;
  decider: Decider;
  seed: number;
  margin: number;
  blue: MatchState["score"][Alliance];
  red: MatchState["score"][Alliance];
  me: {
    fuelPoints: number;
    fuelScored: number;
    fuelInInactiveHub: number;
    climbLevel: number;
    foulsCommitted: number;
    foulPoints: number;
  };
  /** Provider bookkeeping (zero for scripted). */
  provider: { calls: number; robotDecisions: number; fallbacks: number; costUsd: number };
  sticky: {
    contactS: number;
    pinnedS: number;
    fullHopperHubInactiveS: number;
    holdingFuelLast30NotScoringS: number;
    actionFailed: Record<string, number>;
    noProgress: number;
    pathBlocked: number;
    climbCompleted: boolean;
  };
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
/** 95 percent half-width of the mean (normal approximation, sample sd); null when n < 2. */
export function ci95(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return (1.96 * sd) / Math.sqrt(xs.length);
}

export function loadMyRobot(file = repoPath("data", "profiles", "my_robot.json")): RobotProfile {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete raw._note;
  return RobotProfileSchema.parse(raw);
}

function mid(cfg: Config, archetype: Archetype, id: string): RobotProfile {
  return profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id, teamLabel: id }, cfg.game.fuelMassKg.value);
}

export function buildRobots(cfg: Config, mine: RobotProfile, archetype: Archetype, controllerId: string): MatchRobotSpec[] {
  const blue: RobotProfile[] = [mine, mid(cfg, "multilane_fixed", "partner_1"), mid(cfg, "multilane_fixed", "partner_2")];
  const red = [1, 2, 3].map((n) => mid(cfg, archetype, `opp_${archetype}_${n}`));
  return [
    ...blue.map((profile) => ({ profile, alliance: "blue" as const, controllerId })),
    ...red.map((profile) => ({ profile, alliance: "red" as const, controllerId })),
  ];
}

export interface PlayResult {
  m: MatchMetrics;
  wallMs: number;
  cost: number;
  fallbacks: number;
  calls: number;
}

export async function playOne(cfg: Config, mine: RobotProfile, archetype: Archetype, seed: number, decider: Decider): Promise<PlayResult> {
  const robots = buildRobots(cfg, mine, archetype, decider === "drex" ? "drex" : "basic_cycle");
  const agents =
    decider === "drex"
      ? { blue: { provider: getProviderBySpec("drex", cfg, { purpose: "agent_match" }) }, red: { provider: getProviderBySpec("drex", cfg, { purpose: "agent_match" }) } }
      : {};
  const sticky: MatchMetrics["sticky"] = { contactS: 0, pinnedS: 0, fullHopperHubInactiveS: 0, holdingFuelLast30NotScoringS: 0, actionFailed: {}, noProgress: 0, pathBlocked: 0, climbCompleted: false };
  let fuelPoints = 0;
  let fuelScored = 0;
  let inactiveShots = 0;
  const onStep = (events: EngineEvent[], st: MatchState) => {
    const dt = st.rules.physics.dtS;
    const me = st.robots.find((r) => r.id === ME)!;
    let scoredNow = false;
    for (const e of events) {
      if (e.kind === "score" && e.source === "fuel" && e.robotId === ME) {
        scoredNow = true;
        if (e.points > 0) {
          fuelPoints += e.points;
          fuelScored += 1;
        } else inactiveShots += 1;
      } else if (e.kind === "action_failed" && e.robotId === ME) sticky.actionFailed[e.reason] = (sticky.actionFailed[e.reason] ?? 0) + 1;
      else if (e.kind === "no_progress" && e.robotId === ME) sticky.noProgress += 1;
      else if (e.kind === "path_blocked" && e.robotId === ME) sticky.pathBlocked += 1;
    }
    if (me.contact.withRobotId !== null) sticky.contactS += dt;
    if (me.contact.pinnedByRobotId !== null) sticky.pinnedS += dt;
    if (me.fuelHeld >= me.profile.capacity && !st.hubs.blue!.active) sticky.fullHopperHubInactiveS += dt;
    if (st.timeS >= st.rules.autoS + st.rules.teleopS - 30 && me.fuelHeld > 0 && !scoredNow) sticky.holdingFuelLast30NotScoringS += dt;
  };
  const controller = new AgentController({ engine, cfg, seed, robots, agents, scripted: { default: basicCyclePolicy }, timing: "paused", onStep });
  const t0 = performance.now();
  const s = await controller.run();
  const wallMs = performance.now() - t0;
  const st = s.state;
  const me = st.robots.find((r) => r.id === ME)!;
  sticky.climbCompleted = me.climb.level > 0;
  const fouls = st.fouls.filter((f) => f.byRobotId === ME);
  const round = (v: number) => Number(v.toFixed(2));
  for (const k of ["contactS", "pinnedS", "fullHopperHubInactiveS", "holdingFuelLast30NotScoringS"] as const) sticky[k] = round(sticky[k]);
  const blue = st.score.blue!;
  const red = st.score.red!;
  return {
    m: {
      archetype,
      decider,
      seed,
      margin: blue.total - red.total,
      blue,
      red,
      me: { fuelPoints, fuelScored, fuelInInactiveHub: inactiveShots, climbLevel: me.climb.level, foulsCommitted: fouls.length, foulPoints: fouls.reduce((a, f) => a + f.pointsToOpponent, 0) },
      provider: { calls: s.calls.blue + s.calls.red, robotDecisions: s.byAlliance.blue.robotDecisions + s.byAlliance.red.robotDecisions, fallbacks: s.fallbacks.blue + s.fallbacks.red, costUsd: Number((s.byAlliance.blue.costUsd + s.byAlliance.red.costUsd).toFixed(5)) },
      sticky,
    },
    wallMs,
    cost: (["blue", "red"] as const).reduce((a, k) => a + s.byAlliance[k].costUsd, 0),
    fallbacks: s.fallbacks.blue + s.fallbacks.red,
    calls: s.calls.blue + s.calls.red,
  };
}

function meanScore(xs: MatchMetrics["blue"][]) {
  const keys = ["autoFuel", "teleopFuel", "autoTower", "teleopTower", "foulPoints", "fuelInInactiveHub", "total"] as const;
  return Object.fromEntries(keys.map((k) => [k, Number(mean(xs.map((x) => x[k])).toFixed(2))]));
}

export function summarizeRows(ms: MatchMetrics[], decider: Decider) {
  return ARCHETYPES.flatMap((archetype) => {
    const xs = ms.filter((m) => m.archetype === archetype);
    if (xs.length === 0) return [];
    const margins = xs.map((m) => m.margin);
    const ci = ci95(margins);
    return [
      {
        archetype,
        decider,
        n: xs.length,
        meanMargin: Number(mean(margins).toFixed(2)),
        ci95: ci === null ? null : Number(ci.toFixed(2)),
        wins: margins.filter((x) => x > 0).length,
        losses: margins.filter((x) => x < 0).length,
        ties: margins.filter((x) => x === 0).length,
        seeds: xs.map((m) => m.seed),
        marginsBySeed: margins,
        providerCalls: xs.reduce((a, m) => a + m.provider.calls, 0),
        providerFallbackRobotDecisions: xs.reduce((a, m) => a + m.provider.fallbacks, 0),
        costUsd: Number(xs.reduce((a, m) => a + m.provider.costUsd, 0).toFixed(4)),
        myFuelPointsMean: Number(mean(xs.map((m) => m.me.fuelPoints)).toFixed(2)),
        myClimbLevelMean: Number(mean(xs.map((m) => m.me.climbLevel)).toFixed(2)),
        myFoulsMean: Number(mean(xs.map((m) => m.me.foulsCommitted)).toFixed(2)),
        blueMeanBreakdown: meanScore(xs.map((m) => m.blue)),
        redMeanBreakdown: meanScore(xs.map((m) => m.red)),
      },
    ];
  });
}

export function stickyMoments(ms: MatchMetrics[], archetypes: Archetype[]) {
  const xs = ms.filter((m) => archetypes.includes(m.archetype));
  const n = xs.length;
  if (n === 0) return [];
  const per = (f: (m: MatchMetrics) => number) => Number((xs.reduce((a, m) => a + f(m), 0) / n).toFixed(2));
  const reasons: Record<string, number> = {};
  for (const m of xs) for (const [r, c] of Object.entries(m.sticky.actionFailed)) reasons[r] = (reasons[r] ?? 0) + c;
  const out = [
    { label: "Seconds per match in contact with another robot", value: per((m) => m.sticky.contactS) },
    { label: "Seconds per match pinned by an opponent", value: per((m) => m.sticky.pinnedS) },
    { label: "Seconds per match with a full hopper while own hub was inactive", value: per((m) => m.sticky.fullHopperHubInactiveS) },
    { label: "Fuel per match shot into an inactive hub (worth 0)", value: per((m) => m.me.fuelInInactiveHub) },
    { label: "Seconds per match, last 30 s, holding fuel and not scoring (per-tick count)", value: per((m) => m.sticky.holdingFuelLast30NotScoringS) },
    { label: "action_failed events per match", value: per((m) => Object.values(m.sticky.actionFailed).reduce((a, b) => a + b, 0)) },
    { label: "no_progress events per match", value: per((m) => m.sticky.noProgress) },
    { label: "path_blocked events per match", value: per((m) => m.sticky.pathBlocked) },
    { label: "Fraction of matches where the climb completed (ended above level 0)", value: per((m) => (m.sticky.climbCompleted ? 1 : 0)) },
    { label: "Fouls committed per match", value: per((m) => m.me.foulsCommitted) },
  ];
  return [...out, ...Object.entries(reasons).map(([r, c]) => ({ label: `action_failed reason "${r}" per match`, value: Number((c / n).toFixed(2)) }))].map((o) => ({ ...o, matches: n }));
}

async function pool<T>(items: (() => Promise<T>)[], size: number, shouldStart: () => boolean): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length && shouldStart()) {
        const job = items[i++]!;
        out.push(await job());
      }
    }),
  );
  return out;
}

async function main() {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const decider = (arg("decider") ?? "scripted") as Decider;
  if (decider !== "scripted" && decider !== "drex") throw new Error("--decider must be scripted or drex");
  const cfg = loadConfig();
  const mine = loadMyRobot();
  const seeds = cfg.seeds.eval.slice(0, decider === "drex" ? Number(arg("drex-seeds") ?? 2) : Number(arg("seeds") ?? 8));
  const budgetS = Number(arg("budget-s") ?? 600);
  const only = arg("archetypes")?.split(",");
  const jobs = seeds.flatMap((seed) => ARCHETYPES.filter((a) => !only || only.includes(a)).map((a) => ({ a, seed })));
  const results: PlayResult[] = [];
  const t0 = performance.now();
  if (decider === "scripted") {
    for (const j of jobs) results.push(await playOne(cfg, mine, j.a, j.seed, "scripted"));
  } else {
    // The first Drex match is timed alone (about 300 s measured); then the rest run in parallel.
    // --parallel-all skips the solo timing and runs every job at once.
    const parallelAll = process.argv.includes("--parallel-all");
    const first = parallelAll ? null : await playOne(cfg, mine, jobs[0]!.a, jobs[0]!.seed, "drex");
    if (first) {
      results.push(first);
      console.log(`first drex match: ${(first.wallMs / 1000).toFixed(1)} s, ${first.calls} calls, $${first.cost.toFixed(4)}, ${first.fallbacks} fallbacks`);
    }
    const rest = (first ? jobs.slice(1) : jobs).map((j) => () => playOne(cfg, mine, j.a, j.seed, "drex").then((r) => (console.log(`done ${j.a} seed ${j.seed} margin ${r.m.margin} (${(r.wallMs / 1000).toFixed(0)} s)`), r)));
    // Stop starting new matches once there is not time left for one more match of the first one's length.
    const est = first ? first.wallMs / 1000 : 300;
    results.push(...(await pool(rest, parallelAll ? rest.length : 8, () => (performance.now() - t0) / 1000 + est < budgetS)));
  }
  const wallS = (performance.now() - t0) / 1000;
  const allMs = results.map((r) => r.m);
  // A Drex match where more than 10 percent of robot decisions fell back to the scripted policy (for example the endpoint refused calls) is not a Drex-driven number, so it is discarded and counted.
  const ms = decider === "drex" ? allMs.filter((m) => m.provider.fallbacks <= 0.1 * m.provider.robotDecisions) : allMs;
  const rows = summarizeRows(ms, decider);
  const ranked = [...rows].sort((a, b) => a.meanMargin - b.meanMargin);
  const hardest = ranked.slice(0, 2).map((r) => r.archetype);
  const easiest = ranked.slice(-2).reverse().map((r) => r.archetype);
  const mineSummary = {
    decider,
    seeds: [...new Set(ms.map((m) => m.seed))],
    matches: ms.length,
    attempted: allMs.length,
    discardedForFallbacks: allMs.length - ms.length,
    fallbackRule: decider === "drex" ? "matches with more than 10 percent of robot decisions answered by the scripted fallback are discarded" : null,
    wallS: Number(wallS.toFixed(1)),
    matchesPerSecond: Number((ms.length / wallS).toFixed(3)),
    ranking: ranked.map((r) => ({ archetype: r.archetype, meanMargin: r.meanMargin })),
    hardestArchetypes: hardest,
    easiestArchetypes: easiest,
    stickyMoments: stickyMoments(ms, hardest),
    stickyBasis: `matches vs ${hardest.join(" and ")}, decider ${decider}, n=${ms.filter((m) => hardest.includes(m.archetype)).length}`,
    costUsd: Number(results.reduce((a, r) => a + r.cost, 0).toFixed(4)),
    fallbacks: results.reduce((a, r) => a + r.fallbacks, 0),
    providerCalls: results.reduce((a, r) => a + r.calls, 0),
  };
  // Keep the other decider's rows and summary from an existing file; never merge numbers across deciders.
  const file = repoPath("results", "myrobot.json");
  let prevRows: Record<string, unknown>[] = [];
  let by: Record<string, unknown> = {};
  if (existsSync(file)) {
    const prev = JSON.parse(readFileSync(file, "utf8")) as { rows: Record<string, unknown>[]; summary: { byDecider?: Record<string, unknown> } };
    prevRows = prev.rows.filter((r) => r.decider !== decider);
    by = Object.fromEntries(Object.entries(prev.summary.byDecider ?? {}).filter(([k]) => k !== decider));
  }
  by[decider] = mineSummary;
  const scripted = by.scripted as typeof mineSummary | undefined;
  const drex = by.drex as typeof mineSummary | undefined;
  const primary = scripted ?? drex!;
  writeResults({
    experiment: "myrobot",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { game: cfg.game, seedsEval: cfg.seeds.eval, robot: mine },
    rows: [...prevRows, ...rows],
    summary: {
      robotLabel: mine.teamLabel,
      partners: "Blue partners are the same for every archetype: two midpoint multilane_fixed robots (partner_1, partner_2). Only the red opponents change.",
      decider: Object.keys(by),
      hardestArchetypes: primary.hardestArchetypes,
      easiestArchetypes: primary.easiestArchetypes,
      rankingBasis: `decider ${primary.decider}`,
      stickyMoments: primary.stickyMoments,
      stickyBasis: primary.stickyBasis,
      drexMatches: drex?.matches ?? null,
      scriptedMatches: scripted?.matches ?? null,
      byDecider: by,
      drexNote:
        drex === undefined
          ? null
          : drex.matches > 0
            ? `Drex-driven rows cover ${drex.matches} match(es); see byDecider.drex.`
            : "No valid Drex-driven match is in this file. Drex calls were refused with HTTP 403 (Vercel Security Checkpoint) during the later runs, so every robot decision fell back to the scripted policy and those matches were discarded, not reported. Earlier in the session one solo Drex-driven match (drum_fixed, seed 9001) ran for 297.7 s wall, 1202 provider calls, 29 fallbacks, $0.0499, margin -61; its row was not kept because the run that followed overwrote the Drex entry. Run `pnpm bench:myrobot -- --decider drex` when the endpoint is reachable.",
      simplifications: [
        "Opponents are archetype midpoint robots from the config templates (profileFromTemplate with uniform 0.5); they are identical for every seed, so seeds vary only the engine randomness and start state, not the opponents.",
        "Blue partners are two midpoint multilane_fixed robots in every match.",
        "Scripted decider: every robot on both alliances uses the basic_cycle scripted policy. Drex decider: Drex drives all six robots through AgentController, paused timing, no captain step.",
        "95 percent CI is mean +/- 1.96 * sd / sqrt(n) with the normal approximation; null when n < 2. Small n makes it optimistic.",
        "Sticky-moment numbers are per-tick counts at dtS for robot B1 averaged over the matches against the two hardest archetypes (hardest = lowest mean margin under the ranked decider). Holding fuel in the last 30 s without scoring counts ticks with fuel held and no fuel-score event for B1 on that tick, so gaps between shots inside a burst count too.",
        "Fuel shot into an inactive hub is score events with 0 points attributed to B1. Climb completed means B1 ended the match at climb level above 0.",
        "Archetype fields in this repo's config are fabricated ranges (see config archetypes._status), so margins describe the simulator, not real robots.",
      ],
    },
  });
  console.log(`\nmyrobot (${decider}) seeds ${mineSummary.seeds.join(",")}  ${ms.length} matches in ${wallS.toFixed(1)} s = ${mineSummary.matchesPerSecond} matches/s${decider === "drex" ? `  cost $${mineSummary.costUsd}, fallbacks ${mineSummary.fallbacks}` : ""}`);
  console.log("archetype".padEnd(20) + "n".padStart(3) + "mean".padStart(9) + "ci95".padStart(8) + "  W-L-T");
  for (const r of ranked) console.log(r.archetype.padEnd(20) + String(r.n).padStart(3) + r.meanMargin.toFixed(1).padStart(9) + (r.ci95 === null ? "n/a" : r.ci95.toFixed(1)).padStart(8) + `  ${r.wins}-${r.losses}-${r.ties}`);
  console.log(`hardest: ${hardest.join(", ")}   easiest: ${easiest.join(", ")}`);
  for (const s of mineSummary.stickyMoments) console.log(`  ${s.value}  ${s.label}`);
}

if (process.argv[1] && /benchMyRobot\.[tj]s$/.test(process.argv[1])) await main();
