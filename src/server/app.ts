/**
 * HTTP + WebSocket server (owner: P4).
 *
 * STUB: health/config/headline endpoints, an admin-token check, and a demo socket that streams a
 * scripted match on the stub engine. P4 adds run control, provider-driven matches and results.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { HeadlineSchema, PROVIDER_IDS, emptyHeadline, type Config, type EngineEvent } from "../contracts";
import { IMPLEMENTED_PROVIDERS } from "../decide";
import { ENGINE_IS_STUB, engine } from "../engine";
import { MatchRunner, basicCyclePolicy, demoRobots, type RunnerDecision } from "../exec";
import { listUnverified, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import type { ServerMessage } from "./protocol";

/** True when the request carries the right x-admin-token header. Always false if ADMIN_TOKEN is unset. */
export function isAdmin(req: FastifyRequest): boolean {
  const expected = process.env.ADMIN_TOKEN ?? "";
  const given = req.headers["x-admin-token"];
  if (expected === "" || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const provenance = { gitCommit: gitCommit(), simHash: simHash(cfg) };

  app.get("/api/health", async () => ({
    ok: true,
    engineIsStub: ENGINE_IS_STUB,
    ...provenance,
    unverifiedConstants: listUnverified(cfg).length,
  }));

  app.get("/api/config", async () => cfg);

  app.get("/api/providers", async () =>
    PROVIDER_IDS.map((id) => {
      const p = cfg.providers.byId[id];
      return { id, model: p.model, implemented: IMPLEMENTED_PROVIDERS.has(id), keyPresent: p.apiKeyEnv === null || Boolean(process.env[p.apiKeyEnv]) };
    }),
  );

  app.get("/api/headline", async () => {
    const file = repoPath("results", "headline.json");
    if (!existsSync(file)) return emptyHeadline();
    return HeadlineSchema.parse(JSON.parse(readFileSync(file, "utf8")).summary);
  });

  app.post("/api/admin/ping", async (req, reply) => {
    if (!isAdmin(req)) return reply.code(401).send({ error: "missing or wrong x-admin-token" });
    return { ok: true };
  });

  // Streams one scripted match on the stub engine. Query: ?seed=<int>&speed=<1..20>
  app.get("/ws/demo", { websocket: true }, (socket, req) => {
    const query = req.query as { seed?: string; speed?: string };
    const seed = Number.parseInt(query.seed ?? "", 10) || (cfg.seeds.dev[0] ?? 1);
    const speed = Math.min(20, Math.max(1, Number.parseInt(query.speed ?? "", 10) || 2));
    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    const runner = new MatchRunner(engine, cfg, seed, demoRobots(cfg), { default: basicCyclePolicy });
    send({ type: "hello", engineIsStub: ENGINE_IS_STUB, isMock: true, seed, speed });

    const frameMs = 50;
    const ticksPerFrame = Math.max(1, Math.round((speed * frameMs) / 1000 / cfg.physics.dtS));
    const timer = setInterval(() => {
      const events: EngineEvent[] = [];
      const decisions: RunnerDecision[] = [];
      for (let i = 0; i < ticksPerFrame && !runner.finished; i++) {
        const tick = runner.tick();
        events.push(...tick.events);
        decisions.push(...tick.decisions);
      }
      send({ type: "tick", state: runner.state, events, decisions });
      if (runner.finished) {
        clearInterval(timer);
        send({ type: "end", score: { red: runner.state.score.red.total, blue: runner.state.score.blue.total } });
      }
    }, frameMs);
    socket.on("close", () => clearInterval(timer));
  });

  // Serve the built web client when it exists (pnpm build:web). In dev, Vite serves it instead.
  const dist = repoPath("web", "dist");
  if (existsSync(dist)) await app.register(fastifyStatic, { root: dist });

  return app;
}
