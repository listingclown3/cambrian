import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HEADLINE_KEYS, MatchStateSchema } from "../contracts";
import { loadConfig } from "../util/config";
import { buildApp } from "./app";
import type { ServerMessage } from "./protocol";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(loadConfig());
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("server", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, engineIsStub: true });
  });

  it("serves a headline with exactly the contract keys", async () => {
    const res = await app.inject({ method: "GET", url: "/api/headline" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(HEADLINE_KEYS);
  });

  it("lists providers and whether they are implemented", async () => {
    const providers = (await app.inject({ method: "GET", url: "/api/providers" })).json() as { id: string; implemented: boolean }[];
    expect(providers.find((p) => p.id === "drex_mock")?.implemented).toBe(true);
    expect(providers.find((p) => p.id === "drex")?.implemented).toBe(false);
  });

  it("serves usage totals for every tool", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().byTool).sort()).toEqual(["deepinfra", "drex", "intern", "keenable", "ndi", "openai"]);
  });

  it("guards admin routes with ADMIN_TOKEN", async () => {
    const before = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "";
    expect((await app.inject({ method: "POST", url: "/api/admin/ping", headers: { "x-admin-token": "" } })).statusCode).toBe(401);
    process.env.ADMIN_TOKEN = "s3cret";
    expect((await app.inject({ method: "POST", url: "/api/admin/ping" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/ping", headers: { "x-admin-token": "wrong!" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/ping", headers: { "x-admin-token": "s3cret" } })).statusCode).toBe(200);
    process.env.ADMIN_TOKEN = before;
  });

  it("streams a demo match over the websocket", async () => {
    const messages: ServerMessage[] = [];
    const socket = await app.injectWS("/ws/demo?speed=20&seed=5", {}, {
      onInit: (ws) => ws.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as ServerMessage)),
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("no tick message within 5 s")), 5000);
      const poll = setInterval(() => {
        if (messages.some((m) => m.type === "tick")) {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    socket.terminate();
    expect(messages[0]).toMatchObject({ type: "hello", engineIsStub: true, isMock: true, seed: 5, speed: 20 });
    const tick = messages.find((m) => m.type === "tick");
    expect(tick?.type === "tick" && MatchStateSchema.safeParse(tick.state).success).toBe(true);
  });
  it("lists recorded runs and serves a fixture run's events", async () => {
    const runs = (await app.inject({ method: "GET", url: "/api/runs" })).json() as { runId: string; source: string; isMock: boolean }[];
    const fx = runs.find((r) => r.runId === "showcase_fixture");
    expect(fx).toMatchObject({ source: "fixture", isMock: true });
    const events = (await app.inject({ method: "GET", url: "/api/runs/fixture/showcase_fixture/events" })).json() as { type: string }[];
    expect(events[0]?.type).toBe("run_start");
    expect(events.at(-1)?.type).toBe("run_end");
    expect((await app.inject({ method: "GET", url: "/api/runs/fixture/..%2Fetc/events" })).statusCode).toBe(404);
  });

  it("serves scenarios (fixture, marked as such) and results files", async () => {
    const sc = (await app.inject({ method: "GET", url: "/api/scenarios" })).json() as { source: string; scenarios: unknown[] };
    expect(["fixture", "results"]).toContain(sc.source);
    expect(sc.scenarios.length).toBeGreaterThan(0);
    const list = (await app.inject({ method: "GET", url: "/api/results" })).json() as { name: string }[];
    expect(list.some((r) => r.name === "headline")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/results/nope" })).statusCode).toBe(404);
  });

  it("charges simulated latency on /ws/match and replays a fixture on /ws/replay", async () => {
    const collect = async (url: string, until: (m: ServerMessage[]) => boolean) => {
      const messages: ServerMessage[] = [];
      const socket = await app.injectWS(url, {}, { onInit: (ws) => ws.on("message", (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as ServerMessage)) });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timeout")), 8000);
        const poll = setInterval(() => {
          if (until(messages)) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      socket.terminate();
      return messages;
    };
    const m = await collect("/ws/match?speed=40&seed=3&latencyMs=3000", (ms) => ms.filter((x) => x.type === "tick").length >= 10);
    expect(m[0]).toMatchObject({ type: "hello", source: "simulated_latency", isMock: true, chargedLatencyMs: 3000 });
    const r = await collect("/ws/replay?source=fixture&run=showcase_fixture&speed=40", (ms) => ms.some((x) => x.type === "tick"));
    expect(r[0]).toMatchObject({ type: "hello", source: "recorded", isMock: true });
  });
});
