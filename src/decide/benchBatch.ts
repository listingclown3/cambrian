/**
 * pnpm bench:batch [-- --n 10 --n32-giant 10 --seed 1001] (owner: P2)
 *
 * Batched-decision throughput: how long does each decider take, and what does it cost, to answer
 * N questions about ONE match state in ONE call? Batching is how the sim really decides (all
 * robots that need a decision at one moment), so this is the fair throughput comparison.
 * (Lives in src/decide because P2 owns that folder.)
 *
 * Deciders: drex (drex-v2.0), drex-latest (served as drex-max-v1.1), and the giant (deepinfra,
 * reasoning OFF, exact model id logged). Batch sizes 1 and 3 are realistic (one robot; one
 * alliance of three); 8 and 32 are stress sizes.
 *
 * Every decider gets the IDENTICAL request per size. Drex answers it in one /v1/systemone call;
 * the giant in ONE chat completion that must return all N answers in one JSON object keyed by
 * question id (temperature 0, json_object, one parse-retry, then the whole batch is a fallback).
 * Calls run in live mode (no network retries, no cache) with a generous timeout, so latency is a
 * clean single round trip. All real calls go in the usage ledger with purpose "bench_batch".
 *
 * Writes results/bench_batch.json.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { maskThenOptions, type DecisionRequest, type DecisionResponse, type Question } from "../contracts";
import { ENGINE_IS_STUB, buildObservationView, engine } from "../engine";
import { MatchRunner, basicCyclePolicy, demoRobots } from "../exec";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";
import { buildBatchActionRequest, buildCaptainRequest } from "./ask";
import { parseLlmAnswers, type ChatDecisionProvider } from "./providers/deepinfra";
import { BLOCKED_BY_CHECKPOINT, callStats } from "./providers/http";
import { PROMPT_VERSION } from "./options";
import { runEnvironment } from "./runEnv";
import { getProvider, providerReasoning, warmupProvider } from "./registry";
import { renderSelfText, renderSharedStateText } from "./stateText";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const cfg = loadConfig();
const n = Number(arg("--n", "10"));
const nGiant32 = Number(arg("--n32-giant", String(n)));
const seed = Number(arg("--seed", String(cfg.seeds.dev[0] ?? 1001)));
const atS = Number(arg("--at", "35"));
// Live play offers curated options with fact-rich descriptions (options.ts); --full-options
// offers each robot's full masked list with plain descriptions instead.
const fullOptions = process.argv.includes("--full-options");
const optionMode = fullOptions ? "full_masked" : "curated10_facts";
const SIZES = [1, 3, 8, 32] as const;
const SIZE_KIND: Record<number, string> = { 1: "realistic (one robot)", 3: "realistic (one alliance of three)", 8: "stress", 32: "stress" };

// -- one real mid-match state --

const runner = new MatchRunner(engine, cfg, seed, demoRobots(cfg), { default: basicCyclePolicy });
while (runner.state.timeS < atS && !runner.finished) runner.tick();
const blue = runner.state.robots.filter((r) => r.alliance === "blue").map((r) => r.id);
const views = blue.map((id) => buildObservationView(runner.state, id));
const stateText = renderSharedStateText(views);

// -- the question pool, in the order batches take from it --

const actionQs = buildBatchActionRequest(views, 0, "live", {}, fullOptions ? {} : { rules: runner.state.rules }).questions; // next_action_B1..B3
const captainQs = blue.map((id) => buildCaptainRequest(views, id, {}, 0, "live").questions[0]!);
// Follow-up questions: "robot X will do <first option> now; which follow-up after it?", with the
// follow-ups ALLOWED_PAIRS and the robot's masked options allow. Round-robin over robots.
const followUps: Question[][] = views.map((v) =>
  v.options
    .filter((first) => !first.intent.then)
    .map((first) => ({ first, then: maskThenOptions(first, v.options) }))
    .filter((x) => x.then.length > 0)
    .map(({ first, then }) => ({
      id: `then_${v.self.id}_${first.label.replace(/[^A-Za-z0-9]+/g, "_")}`,
      kind: "choice" as const,
      instructions: `${renderSelfText(v)}\nRobot ${v.self.id} will do this first: ${first.description} Choose the best follow-up action for robot ${v.self.id} once that is done, to maximise its alliance's final score margin.`,
      options: then.map(({ label, description }) => ({ label, description })),
    })),
);
const followFlat: Question[] = [];
for (let k = 0; followFlat.length < 64 && followUps.some((l) => l.length > k); k++) for (const l of followUps) if (l[k]) followFlat.push(l[k]!);
const pool: Question[] = [...actionQs, ...captainQs, ...followFlat];
let dup = 1;
while (pool.length < 32) {
  dup += 1;
  for (const q of actionQs) if (pool.length < 32) pool.push({ ...q, id: `${q.id}_dup${dup}` });
}
const batchQuestions = (size: number) => pool.slice(0, size);
const nFollow32 = batchQuestions(32).filter((q) => q.id.startsWith("then_")).length;
const nDup32 = batchQuestions(32).filter((q) => q.id.includes("_dup")).length;
const construction = {
  state: `seed ${seed}, blue alliance at match time ${runner.state.timeS.toFixed(2)} s (scripted basic_cycle play up to then); shared state text = renderSharedStateText of B1-B3's views`,
  size1: "next_action_B1",
  size3: "next_action_B1..B3 (each with that robot's masked options and its own self-description in the instructions)",
  size8: "the 3 action questions + 3 captain-role questions (B1..B3, none assigned yet) + 2 follow-up questions",
  size32: `the 3 action questions + 3 captain-role questions + ${nFollow32} follow-up questions ("robot X will do <option> first; choose the follow-up", options = masked ALLOWED_PAIRS follow-ups), round-robin over B1..B3${nDup32 ? ` + ${nDup32} exact duplicates of the action questions` : ""}`,
  questionIds: Object.fromEntries(SIZES.map((s) => [s, batchQuestions(s).map((q) => q.id)])),
  optionsPerQuestion: Object.fromEntries(SIZES.map((s) => [s, batchQuestions(s).map((q) => q.options?.length ?? 0)])),
};

// -- deciders --

const replies: { text: string; req: DecisionRequest; attempt: number }[] = [];
const ALL_DECIDERS = [
  { key: "drex", provider: getProvider("drex", cfg, { purpose: "bench_batch", timeoutMs: 30_000 }) },
  { key: "drex_latest", provider: getProvider("drex", cfg, { purpose: "bench_batch", timeoutMs: 30_000, model: "drex-latest" }) },
  {
    key: "giant",
    provider: getProvider("deepinfra", cfg, { purpose: "bench_batch", timeoutMs: 180_000, splitQuestions: false, thinking: "off", onReply: (text, req, attempt) => replies.push({ text, req, attempt }) }),
  },
] as const;
type DeciderKey = (typeof ALL_DECIDERS)[number]["key"];
// --only drex,giant runs only those deciders; --merge keeps the other deciders' cells, rows and
// agreement from the existing results/bench_batch.json (so a blocked decider can resume later).
const only = new Set(arg("--only", "drex,drex_latest,giant").split(",")) as Set<string>;
const merge = process.argv.includes("--merge");
const deciders = ALL_DECIDERS.filter((d) => only.has(d.key));
const giant = ALL_DECIDERS[2];
const giantModel = await (giant.provider as ChatDecisionProvider).resolveModel();
const giantReasoning = providerReasoning(giant.provider);
console.log(`engine ${ENGINE_IS_STUB ? "STUB" : "rebuilt"}; ${construction.state}; giant ${giantModel} (reasoning ${giantReasoning}); running ${deciders.map((d) => d.key).join(", ")}${merge ? " (merging into the existing results)" : ""}`);
for (const d of deciders) await warmupProvider(d.provider);

/** Per-answer validity of a raw giant reply (each question scored on its own). */
function validFraction(req: DecisionRequest, text: string): number {
  let ok = 0;
  for (const q of req.questions) {
    try {
      if (!text.includes(`"${q.id}"`)) throw new Error("missing");
      parseLlmAnswers({ ...req, questions: [q] }, text);
      ok += 1;
    } catch {
      /* invalid or missing */
    }
  }
  return ok / req.questions.length;
}

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isCheckpoint = (res: DecisionResponse) => (res.meta.error ?? "").includes(BLOCKED_BY_CHECKPOINT);

const previous = merge && existsSync(repoPath("results", "bench_batch.json")) ? JSON.parse(readFileSync(repoPath("results", "bench_batch.json"), "utf8")) : null;
// Only merge cells measured with the same option mode and prompt version (older files: full_masked, no version).
const sameMode = (x: any) => (x.optionMode ?? "full_masked") === optionMode && (fullOptions || x.promptVersion === PROMPT_VERSION);
const rows: Record<string, unknown>[] = previous ? previous.rows.filter((r: any) => !only.has(r.decider) && sameMode(r) && !/Security Checkpoint|blocked_by_checkpoint/.test(String(r.error ?? ""))) : [];
const cells: Record<string, any> = {};
if (previous) for (const [k, c] of Object.entries<any>(previous.summary.cells ?? {})) if (!only.has(c.decider) && sameMode(c)) cells[k] = { ...c, complete: c.complete ?? (c.okCalls === c.n && c.fallbacks === 0) };
const agreement: Record<string, Record<number, number | null>> = {};
if (previous) for (const [k, a] of Object.entries<any>(previous.summary.agreement_with_single ?? {})) if (!only.has(k)) agreement[k] = a;
const firstAnswers = new Map<string, DecisionResponse>(); // `${decider}:${size}` -> first good batched response
const blockedDeciders = new Set<DeciderKey>(); // Drex behind the bot-protection checkpoint: stop, do not fill with fallbacks

for (const size of SIZES) {
  const questions = batchQuestions(size);
  for (const d of deciders) {
    const calls = d.key === "giant" && size === 32 ? nGiant32 : n;
    const lat: number[] = [];
    const cost: number[] = [];
    const inTok: number[] = [];
    const outTok: number[] = [];
    const valid: number[] = [];
    let fallbacks = 0;
    const models = new Set<string>();
    for (let i = 0; i < calls && !blockedDeciders.has(d.key); i++) {
      const req: DecisionRequest = { stateText, questions, seed: seed + i, mode: "live" };
      const before = replies.length;
      const statsBefore = callStats.length;
      const res = await d.provider.decide(req);
      if (isCheckpoint(res)) {
        console.error(`STOP ${d.key}: ${res.meta.error}`);
        blockedDeciders.add(d.key);
        if (d.key !== "giant") ALL_DECIDERS.filter((x) => x.key !== "giant").forEach((x) => blockedDeciders.add(x.key)); // same host
        break;
      }
      models.add(res.meta.model);
      if (!firstAnswers.has(`${d.key}:${size}`) && !res.meta.fallbackUsed) firstAnswers.set(`${d.key}:${size}`, res);
      const firstReply = replies.slice(before).find((r) => r.attempt === 0);
      const vf = d.key === "giant" ? (firstReply ? validFraction(req, firstReply.text) : 0) : res.meta.fallbackUsed ? 0 : 1;
      if (res.meta.fallbackUsed) fallbacks += 1;
      else {
        lat.push(res.meta.latencyMs);
        cost.push(res.meta.costUsd);
        inTok.push(res.meta.inputTokens);
        outTok.push(res.meta.outputTokens);
      }
      valid.push(vf);
      const attempts = callStats.slice(statsBefore);
      rows.push({
        decider: d.key,
        model: res.meta.model,
        size,
        sizeKind: SIZE_KIND[size],
        call: i,
        latencyMs: res.meta.latencyMs,
        msPerDecision: res.meta.latencyMs / size,
        inputTokens: res.meta.inputTokens,
        outputTokens: res.meta.outputTokens,
        costUsd: res.meta.costUsd,
        costPerDecisionUsd: res.meta.costUsd / size,
        fallbackUsed: res.meta.fallbackUsed,
        error: res.meta.error,
        validAnswerFraction: vf,
        httpAttempts: attempts.length,
        httpHeadersMs: attempts.map((a) => a.headersMs),
        promptVersion: PROMPT_VERSION,
        optionMode,
      });
    }
    const p50 = pct(lat, 0.5);
    const c = {
      decider: d.key,
      models: [...models],
      size,
      sizeKind: SIZE_KIND[size],
      n: calls,
      okCalls: lat.length,
      fallbacks,
      complete: lat.length === calls && fallbacks === 0,
      optionMode,
      promptVersion: PROMPT_VERSION,
      blockedByCheckpoint: blockedDeciders.has(d.key) && lat.length < calls,
      p50Ms: p50,
      p95Ms: pct(lat, 0.95),
      msPerDecisionP50: p50 === null ? null : p50 / size,
      costPerDecisionUsd: mean(cost) === null ? null : mean(cost)! / size,
      costPerCallUsd: mean(cost),
      inputTokensMean: mean(inTok),
      outputTokensMean: mean(outTok),
      validAnswerFraction: mean(valid),
    };
    cells[`${d.key}:${size}`] = c;
    console.log(
      `size ${String(size).padStart(2)} ${d.key.padEnd(11)} ${[...models].join(",").padEnd(24)} n ${calls} ok ${lat.length} fb ${fallbacks}${c.complete ? "" : " INCOMPLETE"}  p50 ${p50?.toFixed(0)} ms p95 ${c.p95Ms?.toFixed(0)} ms  ${c.msPerDecisionP50?.toFixed(1)} ms/decision  $${c.costPerDecisionUsd?.toFixed(7)}/decision  in ${c.inputTokensMean?.toFixed(0)} out ${c.outputTokensMean?.toFixed(0)}  valid ${((c.validAnswerFraction ?? 0) * 100).toFixed(0)}%`,
    );
  }
}

// -- agreement: batched answers vs the same decider's single-question answers --

const pool32 = batchQuestions(32);
for (const d of deciders) {
  if (blockedDeciders.has(d.key)) {
    agreement[d.key] = Object.fromEntries(SIZES.map((s) => [s, null]));
    continue;
  }
  const single = new Map<string, string | undefined>();
  for (const q of pool32) {
    const res = await d.provider.decide({ stateText, questions: [q], seed, mode: "live" });
    if (isCheckpoint(res)) {
      blockedDeciders.add(d.key);
      break;
    }
    single.set(q.id, res.meta.fallbackUsed ? undefined : res.answers[q.id]?.chosen);
  }
  const byDecider: Record<number, number | null> = {};
  for (const size of SIZES) {
    const batched = firstAnswers.get(`${d.key}:${size}`);
    const ids = batchQuestions(size)
      .map((q) => q.id)
      .filter((id) => single.get(id) !== undefined);
    byDecider[size] = !blockedDeciders.has(d.key) && batched && ids.length ? ids.filter((id) => batched.answers[id]?.chosen === single.get(id)).length / ids.length : null;
  }
  agreement[d.key] = byDecider;
  console.log(`agreement with own single-question answers, ${d.key}: ${SIZES.map((s) => `size ${s} ${byDecider[s] == null ? "n/a" : `${(byDecider[s]! * 100).toFixed(0)}%`}`).join(", ")}`);
}

// -- results: a summary number is null unless its cell is complete --

const val = (key: string, field: string) => (cells[key]?.complete ? cells[key][field] : null);
const summary: Record<string, unknown> = {};
for (const size of SIZES) {
  summary[`batch${size}_ms_per_decision_drex`] = val(`drex:${size}`, "msPerDecisionP50");
  summary[`batch${size}_ms_per_decision_giant`] = val(`giant:${size}`, "msPerDecisionP50");
  summary[`batch${size}_ms_per_decision_drex_latest`] = val(`drex_latest:${size}`, "msPerDecisionP50");
  summary[`batch${size}_usd_per_decision_drex`] = val(`drex:${size}`, "costPerDecisionUsd");
  summary[`batch${size}_usd_per_decision_giant`] = val(`giant:${size}`, "costPerDecisionUsd");
  summary[`batch${size}_usd_per_decision_drex_latest`] = val(`drex_latest:${size}`, "costPerDecisionUsd");
  summary[`batch${size}_fallbacks_giant`] = cells[`giant:${size}`]?.fallbacks ?? null;
  summary[`batch${size}_valid_answer_fraction_giant`] = cells[`giant:${size}`]?.validAnswerFraction ?? null;
}
summary.cells = cells;
summary.incomplete_cells = Object.keys(cells).filter((k) => !cells[k].complete);
summary.agreement_with_single = agreement;
summary.models = { drex: cells["drex:1"]?.models ?? null, drex_latest: cells["drex_latest:1"]?.models ?? null, giant: giantModel, giant_reasoning: giantReasoning, giant_label: `${giantModel} (reasoning ${giantReasoning})` };
summary.engine_is_stub = ENGINE_IS_STUB;
summary.notes = [
  "A number is null when its cell is incomplete (see incomplete_cells).",
  "Drex size-32 cells and Drex agreement could not be measured on 2026-11-14 from about 20:58 UTC: console.nace.ai answered every request with HTTP 403 (Vercel security checkpoint, x-vercel-mitigated: challenge). Those calls are not results.",
];

const file = writeResults({
  experiment: "bench_batch",
  createdTs: new Date().toISOString(),
  isMock: false,
  gitCommit: gitCommit(),
  simHash: simHash(cfg),
  config: {
    sizes: SIZES,
    sizeKind: SIZE_KIND,
    nPerCell: n,
    nGiantSize32: nGiant32,
    seed,
    atS,
    giant: { model: giantModel, reasoning: giantReasoning, oneCallPerBatch: true, temperature: 0, responseFormat: "json_object", parseRetries: 1, timeoutMs: 180_000 },
    drex: { models: ["drex-v2.0", "drex-latest"], timeoutMs: 30_000 },
    mode: "live (no network retries, no cache); one warm-up call per decider first",
    construction,
    prices: cfg.pricesPerMTokUsd,
    lastRun: { deciders: deciders.map((d) => d.key), merged: merge },
    optionMode,
    promptVersion: PROMPT_VERSION,
    environment: runEnvironment(),
  },
  rows,
  summary,
});
console.log(`wrote ${file}`);
if (blockedDeciders.size > 0) {
  console.error(`STOPPED: ${[...blockedDeciders].join(", ")} behind the bot-protection checkpoint; their cells are marked incomplete. Re-run with --only ${[...blockedDeciders].join(",")} --merge once the service answers again.`);
  process.exitCode = 2;
}
