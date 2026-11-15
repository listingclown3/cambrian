/**
 * Minimal direct Drex client for src/history/ingest (owner: P5), so ingest work does not wait on the
 * full provider in src/search/steer. One call answers many questions about one state.
 *
 * API (console.nace.ai/docs/drex): POST cfg.providers.byId.drex.endpoint
 *   body { model, state, questions: { [id]: { type, instructions, criteria? } } }
 *     choice: criteria = { [label]: description }      -> answer { choice, confidence, probabilities }
 *     noul:   yes/no; criteria optional                -> answer { noul (P(yes)), confidence }
 *     score:  criteria = [lowest, ..., highest]        -> answer { score, legend, probabilities, confidence }
 *   at most 512 questions per call; 422 is not retryable; 429/5xx honour Retry-After-Ms.
 * Every real call is recorded in the usage ledger (questions counted).
 */
import type { Config } from "../../contracts";
import { recordUsage } from "../../ledger";

export type DrexQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DrexAskResult {
  /** Answers keyed by question id, exactly as Drex returned them. */
  answers: Record<string, any>;
  /** Model that answered. */
  model: string;
  /** Wall-clock milliseconds including retries. */
  latencyMs: number;
  inputTokens: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Ask Drex up to 512 questions about one state. Throws on a non-retryable error. */
export async function drexAsk(cfg: Config, args: { state: unknown; questions: Record<string, DrexQuestion>; purpose: string; model?: string }): Promise<DrexAskResult> {
  const p = cfg.providers.byId.drex;
  const key = process.env[p.apiKeyEnv ?? ""];
  if (!key) throw new Error(`${p.apiKeyEnv} is not set`);
  const count = Object.keys(args.questions).length;
  if (count === 0 || count > 512) throw new Error(`drexAsk: ${count} questions (must be 1..512)`);
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(p.endpoint!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: args.model ?? p.model, state: args.state, questions: args.questions }),
      signal: AbortSignal.timeout(60_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 200) {
      const latencyMs = performance.now() - started;
      const inputTokens = json.usage?.input_tokens ?? 0;
      recordUsage(cfg, { tool: "drex", purpose: args.purpose, model: json.model, inputTokens, outputTokens: json.usage?.output_tokens ?? 0, latencyMs, counts: { questions: count } });
      return { answers: json.answers ?? {}, model: json.model, latencyMs, inputTokens };
    }
    const retryable = [429, 500, 503, 529].includes(res.status);
    if (!retryable || attempt >= 3) throw new Error(`Drex http ${res.status} ${JSON.stringify(json.error ?? {}).slice(0, 300)}`);
    await sleep(Math.min(10_000, Number(res.headers.get("retry-after-ms")) || 1000 * (attempt + 1)));
  }
}
