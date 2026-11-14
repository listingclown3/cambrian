/**
 * pnpm match:agent [-- --blue drex --red deepinfra --timing paused|realtime --seed 1001 --captain]
 *                   [--record <runId>]
 * (owner: P2)
 *
 * --record writes runs/<runId>/events.jsonl (RunEvent JSONL, replayable by the server's
 * /ws/replay?source=runs&run=<runId>); see recorder.ts.
 *
 * Plays one match with AgentController: each alliance is driven by a provider spec (see
 * getProviderBySpec) or "scripted". Prints the final score and, per alliance, calls, fallbacks,
 * charged match seconds, p50/p95 latency, tokens and cost. Real calls are recorded in the usage
 * ledger with purpose "agent_match".
 */
import "dotenv/config";
import { RunEventSchema, type Alliance } from "../contracts";
import { ENGINE_IS_STUB, engine } from "../engine";
import { basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { AgentController, type AllianceAgent } from "./controller";
import { getProviderBySpec, providerReasoning, warmupProvider } from "./registry";
import { MatchRecorder } from "./recorder";
import { BLOCKED_BY_CHECKPOINT, callStats, redact } from "./providers/http";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const seed = Number(arg("--seed", String(cfg.seeds.dev[0] ?? 1)));
const timing = arg("--timing", "paused") as "paused" | "realtime";
// --no-commit / --no-noidle turn the fairness rules off for the before/after comparison.
const fairness = { commitment: !process.argv.includes("--no-commit"), noIdle: !process.argv.includes("--no-noidle"), antiLoop: !process.argv.includes("--no-antiloop") };
const captain = process.argv.includes("--captain");
const specs: Record<Alliance, string> = { blue: arg("--blue", "drex_mock"), red: arg("--red", "scripted") };
const agents: Partial<Record<Alliance, AllianceAgent>> = {};
for (const a of ["blue", "red"] as const) if (specs[a] !== "scripted") agents[a] = { provider: getProviderBySpec(specs[a], cfg, { purpose: "agent_match" }), captain };

const recordId = process.argv.includes("--record") ? arg("--record", "") : null;
if (recordId !== null && !/^[A-Za-z0-9_.-]+$/.test(recordId)) throw new Error("--record needs a run id of letters, digits, _ . -");
const recorder = recordId ? new MatchRecorder(cfg, seed, `${recordId}-seed${seed}`) : null;
// Manifest provider: the single decider spec, or "mixed" when both alliances have one.
const deciders = (["blue", "red"] as const).filter((a) => agents[a]);
const manifestProvider = deciders.length === 1 ? specs[deciders[0]!] : deciders.length === 0 ? "scripted" : "mixed";

// Open each provider's connection before the clock starts (the first cold call can exceed the
// live timeout); warm-up calls are real and recorded in the ledger as purpose "warmup".
if (!process.argv.includes("--no-warmup")) for (const a of deciders) await warmupProvider(agents[a]!.provider);

const started = performance.now();
// Stop (rather than record a match of fallbacks) as soon as a provider is behind a bot-protection checkpoint.
let checkpoint: string | null = null;
const hooks = recorder?.hooks() ?? {};
const onDecision = (d: Parameters<NonNullable<typeof hooks.onDecision>>[0]) => {
  for (const m of d.metas) if (!checkpoint && (m.error ?? "").includes(BLOCKED_BY_CHECKPOINT)) checkpoint = m.error;
  hooks.onDecision?.(d);
};
const controller = new AgentController({ engine, cfg, seed, robots: demoRobots(cfg), agents, scripted: { default: basicCyclePolicy }, timing, fairness, ...hooks, onDecision, shouldStop: () => checkpoint });
let summary: Awaited<ReturnType<AgentController["run"]>>;
try {
  summary = await controller.run();
} catch (e) {
  const msg = redact(String((e as Error)?.message ?? e));
  if (recorder && recordId) recorder.write({ runId: recordId, provider: manifestProvider, status: "error", durationMs: performance.now() - started, error: msg });
  throw e;
}
if (summary.abortedReason) {
  console.error(`STOPPED at match time ${summary.state.timeS.toFixed(1)} s: ${summary.abortedReason}`);
  if (recorder && recordId) recorder.write({ runId: recordId, provider: manifestProvider, status: "error", durationMs: summary.wallMs, error: `stopped: ${summary.abortedReason}` });
  process.exit(2);
}
if (recorder && recordId) {
  // Manifest model: the exact model ids that answered, plus the reasoning setting for chat
  // providers, e.g. "Qwen/Qwen3.5-397B-A17B (reasoning off)"; "blue=...;red=..." when mixed.
  const label = (a: Alliance) => {
    const served = [...new Set(summary.decisions.filter((d) => d.alliance === a).flatMap((d) => d.metas.map((m) => m.model)))].join(",") || "none";
    const r = providerReasoning(agents[a]!.provider);
    return r === null ? served : `${served} (reasoning ${r})`;
  };
  const model = deciders.length === 2 ? deciders.map((a) => `${a}=${label(a)}`).join(";") : deciders.length === 1 ? label(deciders[0]!) : "scripted";
  const behaviour = { fairness: summary.fairness, byAlliance: Object.fromEntries((["blue", "red"] as const).map((a) => [a, { decider: specs[a], robotDecisions: summary.byAlliance[a].robotDecisions, interruptedActions: summary.byAlliance[a].interruptedActions, fastFails: summary.byAlliance[a].fastFails, cooledDown: summary.byAlliance[a].cooledDown, completedCycles: summary.byAlliance[a].completedCycles, idleS: summary.byAlliance[a].idleS, continuationS: summary.byAlliance[a].continuationS, continuations: summary.byAlliance[a].continuations }])), byRobot: summary.byRobot };
  const { file, lines } = recorder.write({ runId: recordId, provider: manifestProvider, model, status: "ok", durationMs: summary.wallMs, error: null, behaviour });
  const bad = lines.filter((l) => !RunEventSchema.safeParse(l).success).length;
  console.log(`recorded ${lines.length} lines (${lines.filter((l) => l.type === "decision").length} decisions) to ${file}; ${bad} lines fail RunEventSchema`);
  if (bad > 0) process.exitCode = 1;
}
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;

console.log(`seed ${seed}, timing ${timing}, captain ${captain}${ENGINE_IS_STUB ? "  [STUB ENGINE: plumbing only, not a result]" : ""}`);
console.log(`final score: blue ${summary.state.score.blue!.total} (${specs.blue}) - red ${summary.state.score.red!.total} (${specs.red}); ${summary.ticks} ticks in ${((performance.now() - started) / 1000).toFixed(1)} s wall`);
for (const a of ["blue", "red"] as const) {
  if (!agents[a]) continue;
  const ds = summary.decisions.filter((d) => d.alliance === a);
  const metas = ds.flatMap((d) => d.metas);
  const lat = metas.map((m) => m.latencyMs);
  const models = [...new Set(metas.map((m) => m.model))].join(",");
  const sum = (f: (m: (typeof metas)[number]) => number) => metas.reduce((s, m) => s + f(m), 0);
  console.log(
    `${a.padEnd(5)} ${specs[a]} (${models}${metas.some((m) => m.isMock) ? ", MOCK" : ""}): ${summary.calls[a]} requests (${summary.byAlliance[a].httpCalls} HTTP calls, ${summary.byAlliance[a].questions} questions), ${ds.reduce((s, d) => s + d.choices.length, 0)} robot decisions, ` +
      `${summary.fallbacks[a]} fallbacks, charged ${summary.chargedS[a].toFixed(2)} match s, p50 ${pct(lat, 0.5).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms, ` +
      `${sum((m) => m.inputTokens)} in / ${sum((m) => m.outputTokens)} out tokens, $${sum((m) => m.costUsd).toFixed(4)}`,
  );
  const errors = [...new Set(metas.map((m) => m.error).filter((e): e is string => e !== null))];
  for (const e of errors.slice(0, 5)) console.log(`      error: ${e}`);
}
console.log(`fairness: commitment ${summary.fairness.commitment ? `on (hold ${summary.fairness.minCommitS} s, coalesce ${summary.fairness.coalesceS} s, critical pin ${summary.fairness.criticalPinS} s)` : "off"}, no-idle ${summary.fairness.noIdle ? `on (max idle ${summary.fairness.maxIdleS} s)` : "off"}`);
for (const a of ["blue", "red"] as const) {
  const t = summary.byAlliance[a];
  const robotDecisions = agents[a] ? t.robotDecisions : summary.state.robots.filter((r) => r.alliance === a).reduce((s, r) => s + summary.byRobot[r.id]!.decisions, 0);
  console.log(`${a.padEnd(5)} ${specs[a].padEnd(16)} robot decisions ${robotDecisions}, fast-failed ${t.fastFails}, cooled down ${t.cooledDown}, interrupted actions ${t.interruptedActions}, completed cycles ${t.completedCycles}, idle ${t.idleS.toFixed(1)} robot-s, role continuation ${t.continuationS.toFixed(1)} robot-s (${t.continuations} handed out)`);
}
console.log(`wall ${(summary.wallMs / 1000).toFixed(1)} s (provider wait ${(summary.providerWaitMs / 1000).toFixed(1)} s, sim ${(summary.simWallMs / 1000).toFixed(1)} s) = ${summary.matchesPerHour.toFixed(1)} matches/hour`);
if (process.argv.includes("--diag")) {
  // Timeout diagnosis: every slow (> 1 s) or failed attempt, plus what the server said about rate limits.
  const stats = callStats.filter((s) => !s.target.endsWith("/models"));
  const statuses = new Map<string, number>();
  for (const s of stats) statuses.set(`${s.target.replace(/^https:\/\/([^/]+).*/, "$1")} ${s.status ?? "none"}`, (statuses.get(`${s.target.replace(/^https:\/\/([^/]+).*/, "$1")} ${s.status ?? "none"}`) ?? 0) + 1);
  console.log(`diag: ${stats.length} attempts; by host and status: ${[...statuses].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  console.log(`diag: max in flight ${Math.max(0, ...stats.map((s) => s.inFlight))}, max queued ${Math.max(0, ...stats.map((s) => s.queuedMs)).toFixed(0)} ms`);
  const headerNames = [...new Set(stats.flatMap((s) => Object.keys(s.rateHeaders)))];
  console.log(`diag: rate-limit headers seen: ${headerNames.join(", ") || "none"}${headerNames.length ? `; last: ${JSON.stringify(stats.findLast((s) => Object.keys(s.rateHeaders).length)?.rateHeaders)}` : ""}`);
  const t0 = stats[0]?.startedMs ?? 0;
  for (const s of stats.filter((x) => x.totalMs > 1000 || x.error)) {
    const prev = stats.filter((x) => x.startedMs < s.startedMs && x.startedMs > s.startedMs - 60_000).length;
    console.log(
      `diag: t=${((s.startedMs - t0) / 1000).toFixed(1)} s status ${s.status ?? "none"} queued ${s.queuedMs.toFixed(0)} ms headers ${s.headersMs?.toFixed(0) ?? "-"} ms total ${s.totalMs.toFixed(0)} ms in flight ${s.inFlight}, ${prev} calls in the previous 60 s${s.error ? `; ${s.error}` : ""}`,
    );
  }
}
if (summary.dropped > 0) console.log(`${summary.dropped} answer(s) arrived after the match ended and were never applied`);
