/**
 * pnpm nace:scenarios -- --latency-only [--n 30] [--decider drex,drex:drex-latest,deepinfra] (owner: P3)
 * Round-trip latency and cost only: one decider at a time, one call at a time (no concurrency),
 * n scenario requests per decider (the benchmark scenarios in id order, cycled). Answers are not
 * scored. A decider whose first 3 calls all fall back is stopped and recorded as unreachable.
 * Entries for deciders not named in this run are kept from the previous file.
 *
 * Writes results/bench_latency.json. Headline latency and cost come from here when present.
 */
import "dotenv/config";
import type { DecisionMeta } from "../../../src/contracts";
import { getProviderBySpec } from "../../../src/providers/registry";
import { loadConfig } from "../../../src/util/config";
import { gitCommit, simHash } from "../../../src/util/provenance";
import { writeResults } from "../../../src/util/runLog";
import { loadScenarioSet, mean, pct, readJson, round, scenarioRequest } from "./common";

const argv = process.argv;
const arg = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const n = Number(arg("n", "30"));
const specs = arg("decider", "drex,drex:drex-latest,deepinfra").split(",");
const idOf = (spec: string) => (spec === "drex:drex-latest" ? "drex-latest" : spec.replace(/[:@]/g, "_"));
const scenarios = loadScenarioSet().scenarios.slice().sort((a, b) => a.id.localeCompare(b.id));
const prev = readJson("results", "bench_latency.json");
const summary: Record<string, unknown> = { ...(prev?.summary ?? {}) };
const rows: Record<string, unknown>[] = (prev?.rows ?? []).filter((r: any) => !specs.map(idOf).includes(r.decider));

for (const spec of specs) {
  const id = idOf(spec);
  const provider = getProviderBySpec(spec, cfg, { purpose: "bench_latency" });
  const metas: DecisionMeta[] = [];
  let stopped: string | null = null;
  for (let i = 0; i < n; i++) {
    const s = scenarios[i % scenarios.length]!;
    const res = await provider.decide(scenarioRequest(s));
    metas.push(res.meta);
    rows.push({ decider: id, i, scenarioId: s.id, latencyMs: round(res.meta.latencyMs, 1), costUsd: res.meta.costUsd, inputTokens: res.meta.inputTokens, outputTokens: res.meta.outputTokens, fallbackUsed: res.meta.fallbackUsed, model: res.meta.model, error: res.meta.error });
    if (i === 2 && metas.every((m) => m.fallbackUsed)) {
      stopped = `stopped: first 3 calls all fell back (${metas[0]!.error ?? ""})`.slice(0, 300);
      break;
    }
  }
  const ok = metas.filter((m) => !m.fallbackUsed);
  const lat = ok.map((m) => m.latencyMs);
  summary[id] = {
    spec,
    models: [...new Set(metas.map((m) => m.model))],
    reasoning: spec.startsWith("deepinfra") ? (spec.endsWith("@think") ? "on" : "off") : null,
    n_calls: metas.length,
    n_ok: ok.length,
    fallbacks: metas.length - ok.length,
    unreachable: stopped,
    p50_ms: lat.length ? round(pct(lat, 0.5), 1) : null,
    p95_ms: lat.length ? round(pct(lat, 0.95), 1) : null,
    mean_ms: lat.length ? round(mean(lat), 1) : null,
    cost_per_1k_usd: ok.length ? round((1000 * ok.reduce((k, m) => k + m.costUsd, 0)) / ok.length, 5) : null,
    mean_input_tokens: ok.length ? round(mean(ok.map((m) => m.inputTokens)), 1) : null,
    isMock: metas.some((m) => m.isMock),
    measuredTs: new Date().toISOString(),
  };
  console.log(`[bench:latency] ${id}: ${JSON.stringify(summary[id])}`);
}
const file = writeResults({
  experiment: "bench_latency",
  createdTs: new Date().toISOString(),
  isMock: Object.values(summary).some((v: any) => v?.isMock),
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: { n, mode: "sequential: one decider at a time, one call at a time; round trip from meta.latencyMs; the scenario requests are the benchmark's identical requests", giantReasoning: "off unless the spec ends in @think" },
  rows,
  summary,
});
console.log(`[bench:latency] -> ${file}`);
