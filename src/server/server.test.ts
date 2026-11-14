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
});
