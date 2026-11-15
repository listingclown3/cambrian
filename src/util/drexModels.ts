/**
 * pnpm steer:models [-- --n 8]: list the Drex models this key can use, then time each on a REAL
 * play-call request (a mid-match robot's state text and its full masked option list), so the
 * model choice in config is made from measurements. Every call is recorded in the usage ledger.
 * Prints status and timings only; never a key or a response body.
 */
import "dotenv/config";
import { engine, buildObservationView } from "../world/worlds/rebuilt/engine";
import { MatchRunner, basicCyclePolicy, demoRobots } from "../world/worlds/rebuilt/exec";
import { buildActionRequest } from "../search/steer";
import { recordUsage } from "../ledger";
import { loadConfig } from "./config";

const cfg = loadConfig();
const p = cfg.providers.byId.drex;
const key = process.env[p.apiKeyEnv ?? ""];
if (!key) {
  console.error(`${p.apiKeyEnv} is not set`);
  process.exit(1);
}
const nArg = process.argv.indexOf("--n");
const n = nArg >= 0 ? Number(process.argv[nArg + 1]) : 8;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
const origin = new URL(p.endpoint!).origin;

const listed = await fetch(`${origin}/v1/models`, { headers, signal: AbortSignal.timeout(20_000) });
const listJson: any = await listed.json().catch(() => ({}));
const models: any[] = listJson.data ?? listJson.models ?? [];
console.log(`GET /v1/models -> http ${listed.status}`);
for (const m of models) console.log(`  ${JSON.stringify(m).slice(0, 300)}`);

// A real request: robot B1, 35 s into a seeded demo match.
const runner = new MatchRunner(engine, cfg, cfg.seeds.dev[0] ?? 1, demoRobots(cfg), { default: basicCyclePolicy });
while (runner.state.timeS < 35) runner.tick();
const req = buildActionRequest(buildObservationView(runner.state, "B1"), 1, "offline");
const question = req.questions[0]!;
const body = (model: string) =>
  JSON.stringify({
    model,
    state: req.stateText,
    questions: { [question.id]: { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(question.options!.map((o) => [o.label, o.description])) } },
  });
console.log(`\nrequest: ${question.options!.length} options, ${req.stateText.length} chars of state; ${n} calls per model\n`);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const candidates = [...new Set(["drex-latest", "drex-v2.0", "drex-max-v1.1", p.model!])];
for (const model of candidates) {
  const roundTrip: number[] = [];
  const evaluation: number[] = [];
  let tokens = 0;
  let served = "";
  let chosen = "";
  let error = "";
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    const res = await fetch(p.endpoint!, { method: "POST", headers, body: body(model), signal: AbortSignal.timeout(30_000) });
    const ms = performance.now() - started;
    const json: any = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      error = `http ${res.status} ${JSON.stringify(json.error ?? {}).slice(0, 160)}`;
      break;
    }
    roundTrip.push(ms);
    evaluation.push(json.evaluation_time_ms);
    tokens = json.usage?.input_tokens ?? 0;
    served = json.model;
    chosen = json.answers?.[question.id]?.choice;
    recordUsage(cfg, { tool: "drex", purpose: "model_check", model: served, inputTokens: tokens, outputTokens: json.usage?.output_tokens ?? 0, latencyMs: ms, counts: { questions: 1 } });
  }
  if (error) console.log(`${model.padEnd(14)} FAIL ${error}`);
  else
    console.log(
      `${model.padEnd(14)} served by ${served.padEnd(14)} round trip p50 ${median(roundTrip).toFixed(0).padStart(4)} ms (min ${Math.min(...roundTrip).toFixed(0)}), evaluation p50 ${median(evaluation).toFixed(1).padStart(6)} ms, ${tokens} input tokens, chose ${chosen}`,
    );
}
