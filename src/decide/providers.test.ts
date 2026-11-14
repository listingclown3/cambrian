import { beforeEach, describe, expect, it } from "vitest";
import { DecisionResponseSchema, type DecisionRequest } from "../contracts";
import { loadConfig } from "../util/config";
import { getProvider, getProviderBySpec, parseProviderSpec, providerLabel, providerModel } from "./registry";
import { deepinfraProvider, renderLlmPrompt } from "./providers/deepinfra";
import { drexProvider } from "./providers/drex";
import { addSpend, redact, resetSpend } from "./providers/http";
import { fakeDeps } from "./testing";

const cfg = loadConfig();

const request: DecisionRequest = {
  stateText: "Our hub is active for 12 more seconds. We hold 30 fuel.",
  questions: [
    {
      id: "pick",
      kind: "choice",
      instructions: "Pick one.",
      options: [
        { label: "a", description: "Option a." },
        { label: "b", description: "Option b." },
        { label: "c", description: "Option c." },
      ],
    },
    { id: "yes_no", kind: "noul", instructions: "Is the hub active?" },
    { id: "rate", kind: "score", instructions: "Rate the threat.", levels: ["low", "medium", "high"] },
  ],
  seed: 3,
  mode: "live",
};

beforeEach(() => resetSpend());

describe("drex provider", () => {
  it("maps the request onto the Drex wire format and the answers back", async () => {
    const deps = fakeDeps({ pick: "b", yes_no: 0.7, rate: "high" });
    const res = DecisionResponseSchema.parse(await drexProvider(cfg, deps).decide(request));
    const body = deps.requests[0]!.body;
    expect(body.model).toBe("drex-v2.0");
    expect(body.state).toBe(request.stateText);
    expect(body.questions.pick).toEqual({ type: "choice", instructions: "Pick one.", criteria: { a: "Option a.", b: "Option b.", c: "Option c." } });
    expect(body.questions.yes_no).toEqual({ type: "noul", instructions: "Is the hub active?" });
    expect(body.questions.rate.criteria).toEqual(["low", "medium", "high"]);

    expect(res.answers.pick!.chosen).toBe("b");
    expect(Object.values(res.answers.pick!.probabilities!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(res.answers.yes_no!.probability).toBe(0.7);
    expect(res.answers.rate!.expectedScore).toBeCloseTo(2, 9);
    expect(res.meta).toMatchObject({ provider: "drex", model: "drex-v2.0", inputTokens: 100, outputTokens: 10, fallbackUsed: false, cached: false, error: null, isMock: false });
    expect(res.meta.costUsd).toBeCloseTo((100 * cfg.pricesPerMTokUsd.byModel["drex-v2.0"]!.input!) / 1e6, 12);
    expect(deps.ledger).toHaveLength(1);
    expect(deps.ledger[0]).toMatchObject({ tool: "drex", model: "drex-v2.0", inputTokens: 100, counts: { questions: 3 } });
  });

  it("selects a second model tier and reports the model actually served", async () => {
    const deps = fakeDeps({ pick: "a" });
    const res = await getProviderBySpec("drex:drex-latest", cfg, deps).decide(request);
    expect(deps.requests[0]!.body.model).toBe("drex-latest");
    expect(res.meta.model).toBe("drex-max-v1.1");
    expect(res.meta.costUsd).toBeCloseTo((100 * cfg.pricesPerMTokUsd.byModel["drex-max-v1.1"]!.input!) / 1e6, 12);
    expect(parseProviderSpec("deepinfra:Qwen/Qwen3.8-27B@think")).toEqual({ id: "deepinfra", model: "Qwen/Qwen3.8-27B", thinking: "on" });
    expect(parseProviderSpec("drex@anon@cache")).toEqual({ id: "drex", anonymize: true, cache: true });
    expect(() => parseProviderSpec("drex@bogus")).toThrow(/unknown provider spec flag/);
  });

  it("flags an answer that is not an offered label instead of passing it on", async () => {
    const res = await drexProvider(cfg, fakeDeps({ pick: "not_a_label" })).decide(request);
    expect(res.meta.fallbackUsed).toBe(true);
    expect(res.meta.error).toMatch(/not an offered label/);
    expect(res.answers.pick!.chosen).toBe("a"); // fallback = first option
    expect(res.answers.yes_no!.probability).toBe(0.5); // other answers still real
  });

  it("never retries a 422, retries 503 only offline, and never throws", async () => {
    const d422 = fakeDeps({}, { status: 422 });
    const r422 = await drexProvider(cfg, d422).decide({ ...request, mode: "offline" });
    expect(r422.meta.fallbackUsed).toBe(true);
    expect(r422.meta.error).toMatch(/422/);
    expect(d422.requests).toHaveLength(1);

    const live = fakeDeps({}, { status: 503 });
    await drexProvider(cfg, live).decide(request);
    expect(live.requests).toHaveLength(1);

    const offline = fakeDeps({}, { status: 503 });
    const res = await drexProvider(cfg, offline).decide({ ...request, mode: "offline" });
    expect(offline.requests).toHaveLength(1 + cfg.providers.byId.drex.retries);
    expect(res.meta.fallbackUsed).toBe(true);
    expect(offline.ledger[0]!.purpose).toBe("decision_failed");
  });

  it("falls back without calling out when the key is missing or a spend cap is hit", async () => {
    const noKey = { ...fakeDeps({}), env: {} };
    const res = await drexProvider(cfg, noKey).decide(request);
    expect(res.meta.fallbackUsed).toBe(true);
    expect(res.meta.error).toMatch(/NACE_API_KEY is not set/);
    expect(noKey.requests).toHaveLength(0);

    addSpend("drex", cfg.spendCapsUsd.perProviderPerRun.drex! + 1);
    const capped = fakeDeps({});
    const r2 = await drexProvider(cfg, capped).decide(request);
    expect(r2.meta.error).toMatch(/spend cap/);
    expect(capped.requests).toHaveLength(0);

    // stops BEFORE a call would cross the cap, not after
    resetSpend();
    addSpend("deepinfra", cfg.spendCapsUsd.perProviderPerRun.deepinfra! - 1e-9);
    const almost = fakeDeps({});
    const r3 = await deepinfraProvider(cfg, almost).decide(request);
    expect(r3.meta.error).toMatch(/would exceed/);
    expect(almost.requests.filter((r) => r.url.includes("chat"))).toHaveLength(0);
  });
});

describe("deepinfra provider", () => {
  it("sends the identical state text and options at temperature 0 and parses a JSON answer", async () => {
    const deps = fakeDeps({ pick: "c", yes_no: 0.2, rate: "medium" });
    const provider = deepinfraProvider(cfg, { ...deps, splitQuestions: false });
    const res = DecisionResponseSchema.parse(await provider.decide(request));
    const chat = deps.requests.find((r) => r.url.includes("chat"))!.body;
    expect(chat.model).toBe("Qwen/Qwen3.5-397B-A17B");
    expect(chat.temperature).toBe(0);
    expect(chat.response_format).toEqual({ type: "json_object" });
    expect(chat.chat_template_kwargs).toEqual({ enable_thinking: false });
    const prompt: string = chat.messages[1].content;
    expect(prompt).toBe(renderLlmPrompt(request));
    expect(prompt).toContain(request.stateText);
    for (const o of request.questions[0]!.options!) expect(prompt).toContain(`- ${o.label}: ${o.description}`);
    expect(prompt).toContain("Pick one.");

    expect(res.answers.pick!.chosen).toBe("c");
    expect(res.answers.pick!.probabilities).toBeNull();
    expect(res.answers.yes_no!.probability).toBe(0.2);
    expect(res.answers.rate!.expectedScore).toBe(1);
    expect(res.meta).toMatchObject({ provider: "deepinfra", model: "Qwen/Qwen3.5-397B-A17B", inputTokens: 200, outputTokens: 20, costUsd: 0.0005, fallbackUsed: false, error: null });
    expect(deps.ledger).toHaveLength(1);
    expect(deps.ledger[0]).toMatchObject({ tool: "deepinfra", costUsd: 0.0005 });
    expect(await provider.resolveModel()).toBe("Qwen/Qwen3.5-397B-A17B");
    expect(await providerModel(getProvider("deepinfra", cfg, { ...deps, cache: true, anonymize: true }), cfg)).toBe("Qwen/Qwen3.5-397B-A17B");
    expect(await providerModel(getProvider("drex", cfg, { ...deps, model: "drex-latest" }), cfg)).toBe("drex-latest");
    expect(await providerLabel(getProvider("deepinfra", cfg, { ...deps, anonymize: true }), cfg)).toBe("Qwen/Qwen3.5-397B-A17B (reasoning off)");
    expect(await providerLabel(getProvider("deepinfra", cfg, { ...deps, thinking: "on" }), cfg)).toBe("Qwen/Qwen3.5-397B-A17B (reasoning on)");
    expect(await providerLabel(getProvider("drex", cfg, deps), cfg)).toBe("drex-v2.0");
  });

  it("parse-retries once, then falls back, counting every call", async () => {
    const good = JSON.stringify({ pick: { choice: "a" }, yes_no: { probability_yes: 1 }, rate: { level: "low" } });
    const once = fakeDeps({}, { chatContent: ["not json at all", good] });
    const r1 = await deepinfraProvider(cfg, { ...once, splitQuestions: false }).decide(request);
    expect(r1.meta.fallbackUsed).toBe(false);
    expect(r1.answers.pick!.chosen).toBe("a");
    expect(r1.meta.inputTokens).toBe(400);
    expect(once.ledger).toHaveLength(2);
    const retryMessages = once.requests.filter((r) => r.url.includes("chat"))[1]!.body.messages;
    expect(retryMessages.at(-1).content).toMatch(/rejected/);

    const twice = fakeDeps({}, { chatContent: ['{"pick":{"choice":"zzz"}}'] });
    const r2 = await deepinfraProvider(cfg, { ...twice, splitQuestions: false }).decide(request);
    expect(r2.meta.fallbackUsed).toBe(true);
    expect(r2.meta.error).toMatch(/parse-retry/);
    expect(r2.meta.costUsd).toBeCloseTo(0.001, 9);
    expect(twice.ledger).toHaveLength(2);
  });

  it("by default answers each question in its own call with the same state text, and sums usage", async () => {
    const deps = fakeDeps({ pick: "b", yes_no: 0.4, rate: "low" });
    const res = DecisionResponseSchema.parse(await deepinfraProvider(cfg, deps).decide(request));
    const chats = deps.requests.filter((r) => r.url.includes("chat"));
    expect(chats).toHaveLength(3);
    for (const c of chats) expect(c.body.messages[1].content).toContain(request.stateText);
    expect(chats.filter((c) => c.body.messages[1].content.includes('Question "pick"'))).toHaveLength(1);
    expect(res.answers.pick!.chosen).toBe("b");
    expect(res.answers.yes_no!.probability).toBe(0.4);
    expect(res.meta).toMatchObject({ inputTokens: 600, outputTokens: 60, fallbackUsed: false, error: null });
    expect(res.meta.costUsd).toBeCloseTo(0.0015, 9);
    expect(deps.ledger).toHaveLength(3);
  });

  it("moves to the next preferred model on an access error", async () => {
    const deps = fakeDeps({ pick: "b", yes_no: 0.5, rate: "low" }, { listed: ["Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3.8-27B"], forbidden: ["Qwen/Qwen3.5-397B-A17B"] });
    const res = await deepinfraProvider(cfg, deps).decide(request);
    expect(res.meta.fallbackUsed).toBe(false);
    expect(res.meta.model).toBe("Qwen/Qwen3.8-27B");
  });
});

describe("redaction", () => {
  it("removes key values and bearer tokens from error text", () => {
    const env = { NACE_API_KEY: "sk-very-secret-value" }; // secret-scan:allow (fake value used to test redaction)
    expect(redact("failed with sk-very-secret-value and Authorization: Bearer abcdefghijkl", env)).toBe("failed with <redacted> and Authorization: Bearer <redacted>");
  });
});
