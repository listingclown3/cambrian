/**
 * pnpm drex:hosts [-- <runId>] (owner: P2): replay 10 console-hosted Drex requests recorded in
 * runs/<runId>/events.jsonl (default selftest-drex) verbatim on the DeepInfra host (drex@di) and
 * compare chosen labels and probabilities. Real calls, purpose "host_compare", spaced 400 ms.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadConfig, repoPath } from "../util/config";
import { getProviderBySpec } from "./registry";
import { drexServerTimings } from "./providers/drex";

// 10 console-hosted Drex answers recorded this morning (runs/selftest-drex), replayed verbatim on DeepInfra.
const cfg = loadConfig();
const lines = readFileSync(repoPath("runs", process.argv[2] ?? "selftest-drex", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const picks = lines.filter((l) => l.type === "decision" && l.meta.provider === "drex" && !l.meta.fallbackUsed && l.probabilities && l.decisionKind === "intent");
const seen = new Set<string>();
const sample = picks.filter((l) => !seen.has(JSON.stringify(l.request)) && seen.add(JSON.stringify(l.request))).filter((_, i) => i % 7 === 0).slice(0, 10);
const p = getProviderBySpec("drex@di", cfg, { purpose: "host_compare", timeoutMs: 10_000 });
let same = 0;
let maxDiff = 0;
for (const l of sample) {
  const qid = `next_action_${l.robotId}`;
  await new Promise((r) => setTimeout(r, 400));
  const res = await p.decide({ ...l.request, mode: "live" });
  if (res.meta.fallbackUsed) {
    console.log(`call failed: ${res.meta.error}`);
    continue;
  }
  const a = res.answers[qid]!;
  const d = Math.max(...Object.keys(l.probabilities).map((k) => Math.abs((a.probabilities?.[k] ?? 0) - l.probabilities[k])));
  maxDiff = Math.max(maxDiff, d);
  if (a.chosen === l.chosenLabel) same += 1;
  console.log(`${l.robotId} t=${l.requestedAtS.toFixed(1)} console ${l.chosenLabel} | deepinfra ${a.chosen}  max |dp| ${d.toFixed(4)}  ${Math.round(res.meta.latencyMs)} ms  ${res.meta.model}`);
}
const ev = drexServerTimings.map((t) => t.evaluationMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
console.log(`same chosen label ${same}/${sample.length}; max probability difference ${maxDiff.toFixed(4)}; server eval p50 ${ev[Math.floor(ev.length / 2)] ?? "n/a"} ms`);
