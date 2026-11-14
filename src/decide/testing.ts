/**
 * Test seams (owner: P2): a fake fetch that speaks the Drex and OpenAI-compatible wire formats,
 * so provider code is exercised end to end in tests without the network or the real ledger.
 * Not for production use.
 */
import type { UsageInput } from "../ledger";
import type { ProviderDeps } from "./providers/http";

/** Canned answer per question id: a label (choice), a probability (noul) or a level (score). */
export type FakeAnswers = Record<string, string | number>;

export interface FakeOptions {
  /** HTTP status to return for decision calls (default 200). */
  status?: number;
  /** Raw chat content to return instead of the JSON built from `answers`. */
  chatContent?: string | string[];
  /** Model ids listed by the fake models endpoint. */
  listed?: string[];
  /** Model ids that return 403 from the chat endpoint. */
  forbidden?: string[];
}

export interface FakeDeps extends ProviderDeps {
  /** Every request the fake received (url + parsed body). */
  requests: { url: string; body: any }[];
  /** Every ledger entry the provider tried to write. */
  ledger: UsageInput[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeDeps(answers: FakeAnswers, opts: FakeOptions = {}): FakeDeps {
  const requests: { url: string; body: any }[] = [];
  const ledger: UsageInput[] = [];
  let chatCalls = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    if (url.endsWith("/models")) return json(200, { data: (opts.listed ?? ["Qwen/Qwen3.5-397B-A17B"]).map((id) => ({ id })) });
    if (opts.status && opts.status !== 200) return json(opts.status, { error: { message: "fake failure" } });
    if (url.includes("systemone")) {
      const out: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        const a = answers[id];
        if (q.type === "choice") {
          const labels = Object.keys(q.criteria);
          const chosen = typeof a === "string" ? a : labels[0];
          out[id] = { type: "choice", choice: chosen, confidence: 0.6, probabilities: Object.fromEntries(labels.map((l) => [l, l === chosen ? 0.6 : 0.4 / Math.max(1, labels.length - 1)])) };
        } else if (q.type === "noul") out[id] = { type: "noul", noul: typeof a === "number" ? a : 0.5, confidence: 0.5 };
        else {
          const levels: string[] = q.criteria;
          const i = Math.max(0, levels.indexOf(String(a)));
          out[id] = { type: "score", score: i, legend: levels, probabilities: levels.map((_, j) => (j === i ? 1 : 0)), confidence: 1 };
        }
      }
      return json(200, { model: body.model === "drex-latest" ? "drex-max-v1.1" : body.model, answers: out, usage: { input_tokens: 100, output_tokens: 10 }, evaluation_time_ms: 5, request_id: "fake" });
    }
    // OpenAI-compatible chat completion.
    if (opts.forbidden?.includes(body.model)) return json(403, { error: { message: `no access to model ${body.model}` } });
    const contents = opts.chatContent === undefined ? undefined : Array.isArray(opts.chatContent) ? opts.chatContent : [opts.chatContent];
    const content =
      contents?.[Math.min(chatCalls, contents.length - 1)] ??
      JSON.stringify(Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, typeof a === "number" ? { probability_yes: a } : { choice: a, level: a }])));
    chatCalls += 1;
    return json(200, { model: body.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 20, estimated_cost: 0.0005 } });
  };
  return {
    fetch: fakeFetch as typeof fetch,
    record: (_cfg, input) => ledger.push(input),
    env: { NACE_API_KEY: "test-nace-key-0000", DEEPINFRA_API_KEY: "test-deepinfra-key-0000" }, // secret-scan:allow (fake test values)
    sleep: async () => {},
    requests,
    ledger,
  };
}
