/**
 * pnpm keys: one minimal REAL call per configured key, to confirm the key and endpoint work.
 * Prints status only. Never prints a key or a response body. Each successful call is recorded in
 * the usage ledger with purpose "key_check".
 */
import "dotenv/config";
import { recordUsage } from "../ledger";
import { loadConfig } from "./config";

const cfg = loadConfig();
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /KEY|TOKEN|SECRET/.test(name) && value && value.length >= 8)
  .map(([, value]) => value!);
/** Short, key-free description of a failure. */
const safe = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, "<redacted>"), text).replace(/\s+/g, " ").slice(0, 160);
const line = (tool: string, ok: boolean | null, detail: string) => console.log(`${ok === null ? "SKIP" : ok ? "OK  " : "FAIL"}  ${tool.padEnd(10)} ${detail}`);

async function call(url: string, init: RequestInit): Promise<{ status: number; json: any; ms: number }> {
  const started = performance.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, ms: performance.now() - started };
}
const describeError = (r: { status: number; json: any }) => `http ${r.status} ${safe(JSON.stringify(r.json?.error ?? r.json?.detail ?? r.json ?? ""))}`;
const authHeaders = (p: { authHeader: string | null; authScheme: string | null; extraHeaders: Record<string, string> }, key: string) => ({
  "Content-Type": "application/json",
  ...p.extraHeaders,
  ...(p.authHeader ? { [p.authHeader]: p.authScheme ? `${p.authScheme} ${key}` : key } : {}),
});

let failures = 0;
const fail = (tool: string, detail: string) => {
  failures += 1;
  line(tool, false, detail);
};

// Drex (System 1). NDI uses the same key and balance, so it is not called separately.
{
  const p = cfg.providers.byId.drex;
  const key = process.env[p.apiKeyEnv ?? ""];
  if (!key) line("drex", null, `${p.apiKeyEnv} is not set`);
  else {
    try {
      const r = await call(p.endpoint!, {
        method: "POST",
        headers: authHeaders(p, key),
        body: JSON.stringify({
          model: p.model,
          state: "Our hub is active for 12 more seconds. We hold 30 fuel and are 2 metres from the hub, aligned.",
          questions: {
            shoot: { type: "choice", instructions: "Choose the best next action.", criteria: { shoot_now: "Shoot the held fuel now.", collect: "Go and collect more fuel first." } },
            hub_active: { type: "noul", instructions: "Is our hub active right now?" },
          },
        }),
      });
      if (r.status !== 200) fail("drex", describeError(r));
      else {
        const usage = r.json.usage ?? {};
        recordUsage(cfg, { tool: "drex", purpose: "key_check", model: r.json.model ?? p.model, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, latencyMs: r.ms, counts: { questions: 2 } });
        line("drex", true, `model ${r.json.model}; ${Math.round(r.ms)} ms round trip, ${r.json.evaluation_time_ms} ms evaluation; chose "${r.json.answers?.shoot?.choice}", P(hub active) ${r.json.answers?.hub_active?.noul}; ${usage.input_tokens} input tokens`);
        console.log(`      answer fields: choice {${Object.keys(r.json.answers?.shoot ?? {}).join(", ")}}  noul {${Object.keys(r.json.answers?.hub_active ?? {}).join(", ")}}`);
      }
    } catch (e) {
      fail("drex", safe(String(e)));
    }
  }
}

// DeepInfra (System 2): list models, pick by preference, one tiny completion.
{
  const p = cfg.providers.byId.deepinfra;
  const key = process.env[p.apiKeyEnv ?? ""];
  if (!key) line("deepinfra", null, `${p.apiKeyEnv} is not set`);
  else {
    try {
      const models = await call(p.modelsEndpoint!, { headers: authHeaders(p, key) });
      const available = new Set<string>((models.json?.data ?? []).map((m: { id: string }) => m.id));
      const model = p.model ?? (p.modelPreference ?? []).find((id) => available.has(id));
      if (!model) fail("deepinfra", `none of modelPreference is available (${available.size} models listed)`);
      else {
        const r = await call(p.endpoint!, {
          method: "POST",
          headers: authHeaders(p, key),
          body: JSON.stringify({ model, temperature: 0, max_tokens: 8, messages: [{ role: "user", content: 'Reply with exactly: {"ok":true}' }] }),
        });
        if (r.status !== 200) fail("deepinfra", `model ${model}: ${describeError(r)}`);
        else {
          const usage = r.json.usage ?? {};
          recordUsage(cfg, { tool: "deepinfra", purpose: "key_check", model, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, latencyMs: r.ms, costUsd: usage.estimated_cost ?? 0 });
          line("deepinfra", true, `model ${model}; ${Math.round(r.ms)} ms round trip; ${usage.prompt_tokens} in / ${usage.completion_tokens} out tokens`);
        }
      }
    } catch (e) {
      fail("deepinfra", safe(String(e)));
    }
  }
}

// Keenable: one search.
{
  const k = cfg.research;
  const key = process.env[k.apiKeyEnv];
  if (!key) line("keenable", null, `${k.apiKeyEnv} is not set`);
  else {
    try {
      const r = await call(`${k.baseUrl}${k.searchPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keenable-Title": k.appTitle, ...(k.authHeader ? { [k.authHeader]: key } : {}) },
        body: JSON.stringify({ query: "FRC 2026 REBUILT game", max_results: 1 }),
      });
      if (r.status !== 200) fail("keenable", describeError(r));
      else {
        recordUsage(cfg, { tool: "keenable", purpose: "key_check", latencyMs: r.ms, counts: { requests: 1 } });
        line("keenable", true, `${Math.round(r.ms)} ms; ${r.json.results?.length ?? 0} result(s); result fields {${Object.keys(r.json.results?.[0] ?? {}).join(", ")}}`);
      }
    } catch (e) {
      fail("keenable", safe(String(e)));
    }
  }
}

line("ndi", null, "shares NACE_API_KEY and its balance with Drex; not called here");
if (!process.env.OPENAI_API_KEY) line("openai", null, "OPENAI_API_KEY is not set (optional secondary baseline)");
process.exit(failures > 0 ? 1 : 0);
