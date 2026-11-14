/**
 * pnpm smoke:drex [-- --provider drex|drex:drex-latest|deepinfra|drex_mock] [--n 10] [--robot B1]
 *   [--thinking off|on|default] [--timeout ms]   (deepinfra only)
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
import { IMPLEMENTED_PROVIDERS, getProviderBySpec, parseProviderSpec } from "./registry";

const argValues = (name: string) => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? process.argv[i + 1]!.split(",") : []));
const specs = argValues("--provider").length > 0 ? argValues("--provider") : ["drex_mock"];
const n = Math.max(1, Number(argValues("--n")[0] ?? 1));
const robotId = argValues("--robot")[0] ?? "B1";
const verbose = n === 1 || process.argv.includes("--verbose");
const thinking = argValues("--thinking")[0] as "default" | "off" | "on" | undefined;
const timeoutMs = argValues("--timeout")[0] ? Number(argValues("--timeout")[0]) : undefined;

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
  return out;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};

let failed = false;
const views = moments(n);
const summary: string[] = [];
for (const spec of specs) {
  const { id } = parseProviderSpec(spec);
  const provider = getProviderBySpec(spec, cfg, { purpose: "smoke", ...(thinking ? { thinking } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const metas: DecisionResponse["meta"][] = [];
  const chosen = new Map<string, number>();
  for (let i = 0; i < views.length; i++) {
    const view = views[i]!;
    const request = DecisionRequestSchema.parse(buildActionRequest(view, seed + i, "live"));
    const response = DecisionResponseSchema.parse(await provider.decide(request));
    const option = chosenOption(view.options, response);
    metas.push(response.meta);
    if (option) chosen.set(option.label, (chosen.get(option.label) ?? 0) + 1);
    if (verbose) {
      console.log(`provider: ${response.meta.provider} (${response.meta.model})${response.meta.isMock ? "  [MOCK]" : ""}`);
      if (i === 0) console.log(`state text:\n${request.stateText.split("\n").map((l) => `  | ${l}`).join("\n")}`);
      console.log(`options offered: ${view.options.length}`);
      console.log(`chosen: ${option?.label ?? "(none)"}${option ? ` - ${option.description}` : ""}`);
      console.log(`meta: ${JSON.stringify(response.meta)}`);
    }
    if (response.meta.fallbackUsed || response.meta.error) {
      console.error(`FAIL [${spec}] call ${i + 1}: fallback used: ${response.meta.error}`);
      failed = true;
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
  summary.push(
    `${spec.padEnd(26)} model ${models.padEnd(24)} ok ${ok.length}/${metas.length}  p50 ${pct(lat, 0.5).toFixed(0)} ms  p95 ${pct(lat, 0.95).toFixed(0)} ms  ` +
      `in ${mean((m) => m.inputTokens).toFixed(0)} tok  out ${mean((m) => m.outputTokens).toFixed(0)} tok  $${mean((m) => m.costUsd).toFixed(6)}/decision  ` +
      `total $${ok.reduce((s, m) => s + m.costUsd, 0).toFixed(5)}${metas[0]?.isMock ? "  [MOCK]" : ""}  top choices ${[...chosen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, c]) => `${l}x${c}`).join(" ")}`,
  );
}

console.log(`\n${n} call(s) per provider, robot ${robotId}, seed ${seed}:`);
for (const line of summary) console.log(`  ${line}`);
if (failed) process.exit(1);
console.log(`\nOK: smoke test passed${specs.every((s) => s === "drex_mock") ? " (mock provider: plumbing only, not a result)" : ""}.`);
