/**
 * pnpm smoke:drex [-- --provider drex|drex:drex-latest|deepinfra|drex_mock] [--n 10] [--robot B1]
 *   [--thinking off|on|default] [--timeout ms]   (deepinfra only)
 *   [--anon]   anonymized-labels ablation (labels shown as opt_01.., descriptions kept)
 *   [--full-options]  offer the full masked list instead of live play's curated 10 with facts
 *   [--network "<one line>"]  network description written into the results file
 * With --n > 1 and a real provider, writes results/smoke_latency.json (one entry per provider
 * spec and option mode, merged with entries from earlier runs), including the run environment.
 * (owner: P2)
 *
 * End-to-end smoke test of the decision path: stub match -> one robot's view -> masked options
 * -> DecisionRequest -> provider -> validated DecisionResponse -> Intent.
 * Defaults to drex_mock so it runs with no API key. Exits non-zero on any contract violation or
 * any fallback answer. `--provider` may be repeated or comma-separated; `--n` makes that many
 * calls per provider (each at a different match time) and prints p50/p95 latency, tokens and
 * cost per decision. Real calls are recorded in the usage ledger with purpose "smoke".
 */
import "dotenv/config";
import { DecisionRequestSchema, DecisionResponseSchema, IntentSchema, type DecisionResponse } from "../contracts";
import { buildObservationView, engine } from "../engine";
import { basicCyclePolicy, demoRobots, MatchRunner } from "../exec";
import { loadConfig } from "../util/config";
import { buildActionRequest, chosenOption } from "./ask";
import { IMPLEMENTED_PROVIDERS, getProviderBySpec, parseProviderSpec, warmupProvider } from "./registry";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";
import { PROMPT_VERSION } from "./options";
import { runEnvironment } from "./runEnv";

const argValues = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? process.argv[i + 1]!.split(",") : []));
const specs = argValues("--provider").length > 0 ? argValues("--provider") : ["drex_mock"];
const n = Math.max(1, Number(argValues("--n")[0] ?? 1));
const robotId = argValues("--robot")[0] ?? "B1";
const verbose = n === 1 || process.argv.includes("--verbose");
const thinking = argValues("--thinking")[0] as "default" | "off" | "on" | undefined;
const anon = process.argv.includes("--anon");
const timeoutMs = argValues("--timeout")[0] ? Number(argValues("--timeout")[0]) : undefined;
const fullOptions = process.argv.includes("--full-options");
const optionMode = fullOptions ? "full_masked" : "curated10_facts";

const cfg = loadConfig();
const seed = cfg.seeds.dev[0] ?? 1;

/** n decision moments: robot `robotId` at match times spread from 35 s on (one match, scripted). */
function moments(count: number) {
  const runner = new MatchRunner(engine, cfg, seed, demoRobots(cfg), { default: basicCyclePolicy });
  const out: ReturnType<typeof buildObservationView>[] = [];
  const times = Array.from({ length: count }, (_, i) => 35 + i * Math.max(1, Math.floor(100 / count)));
  for (const t of times) {
    while (runner.state.timeS < t && !runner.finished) runner.tick();
    out.push(buildObservationView(runner.state, robotId));
  }
  return { views: out, rules: runner.state.rules };
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};

let failed = false;
const { views, rules } = moments(n);
const present = fullOptions ? {} : { rules };
const fileRows: Record<string, unknown>[] = [];
const fileCells: Record<string, unknown>[] = [];
const summary: string[] = [];
for (const spec of specs) {
  const { id } = parseProviderSpec(spec);
  const provider = getProviderBySpec(spec, cfg, { purpose: "smoke", ...(anon ? { anonymize: true } : {}), ...(thinking ? { thinking } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  await warmupProvider(provider);
  const metas: DecisionResponse["meta"][] = [];
  const chosen = new Map<string, number>();
  for (let i = 0; i < views.length; i++) {
    const view = views[i]!;
    const request = DecisionRequestSchema.parse(buildActionRequest(view, seed + i, "live", present));
    const response = DecisionResponseSchema.parse(await provider.decide(request));
    const option = chosenOption(view.options, response);
    metas.push(response.meta);
    fileRows.push({ spec, optionMode, promptVersion: PROMPT_VERSION, call: i, matchTimeS: view.timeS, options: request.questions[0]!.options!.length, chosenLabel: option?.label ?? null, ...response.meta });
    if (option) chosen.set(option.label, (chosen.get(option.label) ?? 0) + 1);
    if (verbose) {
      console.log(`provider: ${response.meta.provider} (${response.meta.model})${response.meta.isMock ? "  [MOCK]" : ""}`);
      if (i === 0) console.log(`state text:\n${request.stateText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
      console.log(`options offered: ${request.questions[0]!.options!.length} of ${view.options.length} masked (${optionMode})`);
      console.log(`chosen: ${option?.label ?? "(none)"}${option ? ` - ${option.description}` : ""}`);
      console.log(`meta: ${JSON.stringify(response.meta)}`);
    }
    if (response.meta.fallbackUsed || response.meta.error) {
      console.error(`FAIL [${spec}] call ${i + 1}: fallback used: ${response.meta.error}`);
      failed = true;
      if ((response.meta.error ?? "").includes("blocked_by_checkpoint")) {
        console.error(`STOP [${spec}]: behind a bot-protection checkpoint; no further calls to it.`);
        break;
      }
      continue;
    }
    if (!option) {
      console.error(`FAIL [${spec}] call ${i + 1}: the provider did not choose one of the offered options.`);
      failed = true;
      continue;
    }
    IntentSchema.parse(option.intent);
    const probabilities = response.answers.next_action?.probabilities;
    if (probabilities) {
      const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
      if (Math.abs(total - 1) > 1e-6) {
        console.error(`FAIL [${spec}]: probabilities sum to ${total}, not 1.`);
        failed = true;
      }
    }
  }
  if (!IMPLEMENTED_PROVIDERS.has(id)) {
    console.error(`FAIL: provider "${id}" is not implemented yet; the answers are fallbacks.`);
    failed = true;
  }
  const ok = metas.filter((m) => !m.fallbackUsed);
  const lat = ok.map((m) => m.latencyMs);
  const mean = (f: (m: DecisionResponse["meta"]) => number) => (ok.length ? ok.reduce((s, m) => s + f(m), 0) / ok.length : NaN);
  const models = [...new Set(metas.map((m) => m.model))].join(",");
  fileCells.push({
    spec,
    optionMode,
    promptVersion: PROMPT_VERSION,
    models: [...new Set(metas.map((m) => m.model))],
    n: metas.length,
    ok: ok.length,
    fallbacks: metas.length - ok.length,
    p50Ms: ok.length ? pct(lat, 0.5) : null,
    p95Ms: ok.length ? pct(lat, 0.95) : null,
    inputTokensMean: ok.length ? mean((m) => m.inputTokens) : null,
    outputTokensMean: ok.length ? mean((m) => m.outputTokens) : null,
    costPerDecisionUsd: ok.length ? mean((m) => m.costUsd) : null,
    isMock: metas.some((m) => m.isMock),
  });
  summary.push(
    `${spec.padEnd(26)} model ${models.padEnd(24)} ok ${ok.length}/${metas.length}  p50 ${pct(lat, 0.5).toFixed(0)} ms  p95 ${pct(lat, 0.95).toFixed(0)} ms  ` +
      `in ${mean((m) => m.inputTokens).toFixed(0)} tok  out ${mean((m) => m.outputTokens).toFixed(0)} tok  $${mean((m) => m.costUsd).toFixed(6)}/decision  ` +
      `total $${ok.reduce((s, m) => s + m.costUsd, 0).toFixed(5)}${metas[0]?.isMock ? "  [MOCK]" : ""}  top choices ${[...chosen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, c]) => `${l}x${c}`).join(" ")}`,
  );
}

console.log(`\n${n} call(s) per provider, robot ${robotId}, seed ${seed}:`);
for (const line of summary) console.log(`  ${line}`);
if (n > 1 && fileCells.some((c) => !c.isMock)) {
  const file = repoPath("results", "smoke_latency.json");
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const key = (x: any) => `${x.spec}|${x.optionMode}`;
  const mine = new Set(fileCells.map(key));
  const written = writeResults({
    experiment: "smoke_latency",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { seed, robotId, n, promptVersion: PROMPT_VERSION, optionMode, mode: "live", environment: runEnvironment() },
    rows: [...(prev?.rows ?? []).filter((r: any) => !mine.has(key(r))), ...fileRows.filter((r) => !(r as any).isMock)],
    summary: { cells: [...(prev?.summary?.cells ?? []).filter((c: any) => !mine.has(key(c))), ...fileCells.filter((c) => !c.isMock).map((c) => ({ ...c, environment: runEnvironment() }))] },
  });
  console.log(`wrote ${written}`);
}
if (failed) process.exit(1);
console.log(`\nOK: smoke test passed${specs.every((s) => s === "drex_mock") ? " (mock provider: plumbing only, not a result)" : ""}.`);
