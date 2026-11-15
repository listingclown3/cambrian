import { describe, expect, it } from "vitest";
import { DecisionResponseSchema, type DecisionRequest } from "../contracts";
import { fakeDeps } from "../search/steer/testing";
import { loadConfig } from "../util/config";
import { resolveOpenAICompatible } from "./openaiCompatible";
import { getProvider } from "./registry";

const cfg = loadConfig();
const request: DecisionRequest = {
  stateText: "test state",
  questions: [
    { id: "pick", kind: "choice", instructions: "Pick one.", options: [{ label: "a", description: "Option a." }, { label: "b", description: "Option b." }] },
    { id: "yes_no", kind: "noul", instructions: "Is the hub active?" },
  ],
  seed: 3,
  mode: "offline",
};

describe("openai_compatible provider", () => {
  it("takes endpoint and model from the environment, trimming a trailing slash", () => {
    const p = resolveOpenAICompatible(cfg.providers.byId.openai_compatible, { OPENAI_COMPATIBLE_BASE_URL: "http://gpu-box:8000/v1/", OPENAI_COMPATIBLE_MODEL: "my/model" });
    expect(p.endpoint).toBe("http://gpu-box:8000/v1/chat/completions");
    expect(p.modelsEndpoint).toBe("http://gpu-box:8000/v1/models");
    expect(p.model).toBe("my/model");
  });

  it("falls back, flagged, when no endpoint is configured", async () => {
    const deps = fakeDeps({ pick: "b", yes_no: 0.7 });
    const res = DecisionResponseSchema.parse(await getProvider("openai_compatible", cfg, { ...deps, env: {} }).decide(request));
    expect(res.meta.fallbackUsed).toBe(true);
    expect(deps.requests).toHaveLength(0);
  });

  it("calls the configured server and returns a real answer, with or without an API key", async () => {
    for (const key of [undefined, "secret-test-key-0000"]) {
      const deps = fakeDeps({ pick: "b", yes_no: 0.7 });
      const env = { OPENAI_COMPATIBLE_BASE_URL: "http://gpu-box:8000/v1", OPENAI_COMPATIBLE_MODEL: "my/model", ...(key ? { OPENAI_COMPATIBLE_API_KEY: key } : {}) };
      const res = DecisionResponseSchema.parse(await getProvider("openai_compatible", cfg, { ...deps, env }).decide(request));
      expect(res.meta.fallbackUsed).toBe(false);
      expect(res.meta.provider).toBe("openai_compatible");
      expect(res.answers.pick?.chosen).toBe("b");
      expect(deps.requests.some((r) => r.url === "http://gpu-box:8000/v1/chat/completions" && r.body?.model === "my/model")).toBe(true);
    }
  });
});
