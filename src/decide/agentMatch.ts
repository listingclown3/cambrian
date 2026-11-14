/**
 * pnpm match:agent [-- --blue drex --red deepinfra --timing paused|realtime --seed 1001 --captain]
 * (owner: P2)
 *
 * Plays one match with AgentController: each alliance is driven by a provider spec (see
 * getProviderBySpec) or "scripted". Prints the final score and, per alliance, calls, fallbacks,
 * charged match seconds, p50/p95 latency, tokens and cost. Real calls are recorded in the usage
 * ledger with purpose "agent_match".
 */
import "dotenv/config";
import type { Alliance } from "../contracts";
import { ENGINE_IS_STUB, engine } from "../engine";
import { basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig } from "../util/config";
import { AgentController, type AllianceAgent } from "./controller";
import { getProviderBySpec } from "./registry";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const seed = Number(arg("--seed", String(cfg.seeds.dev[0] ?? 1)));
const timing = arg("--timing", "paused") as "paused" | "realtime";
const captain = process.argv.includes("--captain");
const specs: Record<Alliance, string> = { blue: arg("--blue", "drex_mock"), red: arg("--red", "scripted") };
const agents: Partial<Record<Alliance, AllianceAgent>> = {};
for (const a of ["blue", "red"] as const) if (specs[a] !== "scripted") agents[a] = { provider: getProviderBySpec(specs[a], cfg, { purpose: "agent_match" }), captain };

const started = performance.now();
const summary = await new AgentController({ engine, cfg, seed, robots: demoRobots(cfg), agents, scripted: { default: basicCyclePolicy }, timing }).run();
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
    `${a.padEnd(5)} ${specs[a]} (${models}${metas.some((m) => m.isMock) ? ", MOCK" : ""}): ${summary.calls[a]} calls, ${ds.reduce((s, d) => s + d.choices.length, 0)} robot decisions, ` +
      `${summary.fallbacks[a]} fallbacks, charged ${summary.chargedS[a].toFixed(2)} match s, p50 ${pct(lat, 0.5).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms, ` +
      `${sum((m) => m.inputTokens)} in / ${sum((m) => m.outputTokens)} out tokens, $${sum((m) => m.costUsd).toFixed(4)}`,
  );
}
if (summary.dropped > 0) console.log(`${summary.dropped} answer(s) arrived after the match ended and were never applied`);
