/**
 * pnpm leaktest [-- --decider deepinfra] (owner: P3) - DEBUG ONLY, never a reported result.
 * On 10 scenarios, append the answer-key values to the state text and ask the decider. A decider
 * that does not pick the best option with the answer in front of it points to a label / order /
 * id mapping bug in the request path. Writes cache/leak_test_<decider>.json (not results/).
 */
import "dotenv/config";
import { getProviderBySpec } from "../decide/registry";
import { loadConfig } from "../util/config";
import { loadScenarioSet, round, scenarioRequest, writeJson } from "./common";

const i = process.argv.indexOf("--decider");
const spec = i >= 0 ? process.argv[i + 1]! : "deepinfra";
const cfg = loadConfig();
const scenarios = loadScenarioSet().scenarios.slice().sort((a, b) => a.id.localeCompare(b.id));
const pick = [...scenarios.filter((s) => !s.answerKey!.ambiguous), ...scenarios.filter((s) => s.answerKey!.ambiguous)].slice(0, 10);
const provider = getProviderBySpec(spec, cfg, { purpose: "leak_test_debug" });
const rows = [];
for (const s of pick) {
  const req = scenarioRequest(s);
  const table = Object.entries(s.answerKey!.values)
    .sort((a, b) => b[1].mean - a[1].mean)
    .map(([l, v]) => `${l}: expected final margin ${v.mean.toFixed(1)}`)
    .join("\n");
  req.stateText += `\n\nDEBUG (leak test): simulated value of each option, higher is better:\n${table}`;
  const res = await provider.decide(req);
  const chosen = res.answers.next_action?.chosen ?? null;
  rows.push({ scenarioId: s.id, best: s.answerKey!.best, chosen, ok: chosen === s.answerKey!.best, fallback: res.meta.fallbackUsed, model: res.meta.model, latencyMs: round(res.meta.latencyMs, 0) });
  console.log(`[leaktest] ${s.id}: best ${s.answerKey!.best}, chose ${chosen}${res.meta.fallbackUsed ? " (FALLBACK)" : ""}`);
}
const ok = rows.filter((r) => r.ok).length;
writeJson({ note: "DEBUG ONLY: answer key shown to the decider; never report.", spec, createdTs: new Date().toISOString(), ok, n: rows.length, rows }, "cache", `leak_test_${spec.replace(/[:@/]/g, "_")}.json`);
console.log(`[leaktest] ${spec}: ${ok}/${rows.length} picked the best option with the answer shown`);
