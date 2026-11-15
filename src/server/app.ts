/**
 * HTTP + WebSocket server (owner: P4).
 *
 * STUB: health/config/headline endpoints, an admin-token check, and a demo socket that streams a
 * scripted match on the stub engine. P4 adds run control, provider-driven matches and results.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { HeadlineSchema, ResultsFileSchema, stepLabel, PROVIDER_IDS, emptyHeadline, type Config, type EngineEvent } from "../contracts";
import { IMPLEMENTED_PROVIDERS } from "../search/steer";
import { ENGINE_IS_STUB, engine } from "../world/worlds/rebuilt/engine";
import { MatchRunner, basicCyclePolicy, demoRobots, type RunnerDecision } from "../world/worlds/rebuilt/exec";
import { readUsage, summarizeUsage } from "../ledger";
import { listUnverified, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { streamAgentMatch } from "./agentMatch";
import { ChargedMatch } from "./chargedMatch";
import { ReplaySim } from "./replaySim";
import { slimFrame, slimStatic } from "./slim";
import type { DecisionNote, ServerMessage } from "./protocol";
import { listRuns, readRunEvents, runFile } from "./runs";

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
    // A file written before a contract change no longer matches; show "not run" rather than fail.
    const parsed = HeadlineSchema.safeParse(JSON.parse(readFileSync(file, "utf8")).summary);
    return parsed.success ? parsed.data : emptyHeadline();
  });

  // Live per-tool usage counters for the "Built with" panel (real calls only).
  app.get("/api/usage", async () => summarizeUsage(readUsage(cfg), cfg));

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

  // ── recorded runs ─────────────────────────────────────────────────────────
  app.get("/api/runs", async () => listRuns());
  app.get("/api/runs/:source/:runId/events", async (req, reply) => {
    const { source, runId } = req.params as { source: string; runId: string };
    const file = source === "runs" || source === "fixture" ? runFile(runId, source) : null;
    if (!file) return reply.code(404).send({ error: "no such run" });
    return readRunEvents(file);
  });

  // ── results files (results/*.json), served as written; the web client reads isMock itself ──
  const resultNames = () =>
    existsSync(repoPath("results")) ? readdirSync(repoPath("results")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)) : [];
  app.get("/api/results", async () =>
    resultNames().flatMap((name) => {
      try {
        const f = ResultsFileSchema.parse(JSON.parse(readFileSync(repoPath("results", name + ".json"), "utf8")));
        return [{ name, experiment: f.experiment, createdTs: f.createdTs, isMock: f.isMock, gitCommit: f.gitCommit, rows: f.rows.length }];
      } catch {
        return [];
      }
    }),
  );
  app.get("/api/results/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!resultNames().includes(name)) return reply.code(404).send({ error: "no such results file" });
    return JSON.parse(readFileSync(repoPath("results", name + ".json"), "utf8"));
  });

  // Initial (idle) field so the UI can always draw the field, even before a match starts.
  app.get("/api/idle", async () => {
    const st = engine.createMatch(cfg, cfg.seeds.dev[0] ?? 1, demoRobots(cfg));
    return { statics: slimStatic(st), frame: slimFrame(st) };
  });

  // Which model the giant is: the first-choice id (the exact id used is logged in each run's manifest) and its reasoning mode.
  app.get("/api/giant", async () => {
    const p = cfg.providers.byId.deepinfra;
    return { fixedModel: p.model, firstChoice: p.modelPreference?.[0] ?? null, reasoning: "off" };
  });

  // Static data files for the Rules & Sources page and robot provenance badges. Missing file = { available: false }.
  const dataFile = (rel: string[], empty: object) => async () => {
    const file = repoPath(...rel);
    return existsSync(file) ? { available: true, ...(JSON.parse(readFileSync(file, "utf8")) as object) } : { available: false, ...empty };
  };
  app.get("/api/rules/conduct", dataFile(["data", "rules", "conduct_rules.json"], { rules: [] }));
  app.get("/api/research/sources", dataFile(["data", "research", "sources.json"], { sources: [] }));
  app.get("/api/league/teams", dataFile(["data", "league", "teams_from_docs.json"], { teams: [] }));

  // Scenario explorer data: real results/scenarios.json when it exists, else the bundled FIXTURE.
  app.get("/api/scenarios", async () => {
    const real = repoPath("results", "scenarios.json");
    if (existsSync(real)) return { source: "results", ...JSON.parse(readFileSync(real, "utf8")) };
    const dataFile = repoPath("data", "scenarios", "scenarios.json");
    if (existsSync(dataFile)) return { source: "results", picks: {}, ...JSON.parse(readFileSync(dataFile, "utf8")) };
    const fixture = repoPath("src", "server", "fixtures", "scenarios_fixture.json");
    if (existsSync(fixture)) return { source: "fixture", ...JSON.parse(readFileSync(fixture, "utf8")) };
    return { source: "none", families: [], scenarios: [], picks: {} };
  });

  // Match with decision latency CHARGED to the match clock. SIMULATED latency until providers drive matches.
  // Query: ?seed=&speed=&decider=&latencyMs=
  app.get("/ws/match", { websocket: true }, (socket, req) => {
    const q = req.query as { seed?: string; speed?: string; decider?: string; latencyMs?: string };
    const seed = Number.parseInt(q.seed ?? "", 10) || (cfg.seeds.dev[0] ?? 1);
    const speed = Math.min(40, Math.max(1, Number.parseInt(q.speed ?? "", 10) || 4));
    const latencyMs = Math.min(60000, Math.max(0, Number.parseInt(q.latencyMs ?? "", 10) || 0));
    const decider = (q.decider ?? "Decider").slice(0, 24);
    const alliance = cfg.server.demoDrexAlliance;
    const send = (m: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    const match = new ChargedMatch(engine, cfg, seed, demoRobots(cfg), basicCyclePolicy, { chargedAlliance: alliance, latencyMs });
    send({
      type: "hello",
      engineIsStub: ENGINE_IS_STUB,
      isMock: true,
      seed,
      speed,
      source: "simulated_latency",
      decider,
      deciderAlliance: alliance,
      chargedLatencyMs: latencyMs,
      latencySource: "SIMULATED: scripted policy with a fixed charged latency; no provider is being called",
      statics: slimStatic(match.state),
    });
    pump(socket, match, speed, cfg.physics.dtS, send);
  });

  // Provider-driven match: Drex or the giant decides for one alliance (real calls, logged to runs/).
  // Query: ?provider=drex|deepinfra&seed=&timing=realtime|paused&speed=&log=0|1
  app.get("/ws/agents", { websocket: true }, (socket, req) => {
    const q = req.query as { provider?: string; seed?: string; timing?: string; speed?: string; log?: string };
    const send = (m: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    if (q.provider !== "drex" && q.provider !== "deepinfra") return void send({ type: "error", message: "provider must be drex or deepinfra" });
    const stop = streamAgentMatch(
      cfg,
      {
        provider: q.provider,
        seed: Number.parseInt(q.seed ?? "", 10) || (cfg.seeds.dev[0] ?? 1),
        timing: q.timing === "paused" ? "paused" : "realtime",
        speed: Math.min(40, Math.max(1, Number.parseInt(q.speed ?? "", 10) || 4)),
        alliance: cfg.server.demoDrexAlliance,
        log: q.log !== "0",
      },
      send,
    );
    socket.on("close", stop);
  });

  // Replays a recorded run offline (see replaySim.ts). Query: ?source=&run=&speed=
  app.get("/ws/replay", { websocket: true }, (socket, req) => {
    const q = req.query as { source?: string; run?: string; speed?: string };
    const source = q.source === "runs" ? "runs" : "fixture";
    const file = runFile(q.run ?? "", source);
    const send = (m: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    if (!file) return void socket.close(1008, "no such run");
    const speed = Math.min(40, Math.max(1, Number.parseInt(q.speed ?? "", 10) || 6));
    let sim: ReplaySim;
    try {
      sim = new ReplaySim(readRunEvents(file), { runId: q.run ?? "", isFixture: source === "fixture", speed, engineIsStub: ENGINE_IS_STUB });
    } catch (e) {
      return void socket.close(1008, e instanceof Error ? e.message.slice(0, 100) : "bad run");
    }
    send(sim.hello);
    const ticks = Math.max(1, Math.round((speed * 50) / 1000 / cfg.physics.dtS));
    // one bounded slice per timer callback; the event loop is free in between
    const timer = setInterval(() => {
      for (const m of sim.frame(ticks)) send(m);
      if (sim.finished) clearInterval(timer);
    }, 50);
    socket.on("close", () => clearInterval(timer));
  });

  // Serve the built web client when it exists (pnpm build:web). In dev, Vite serves it instead.
  const dist = repoPath("web", "dist");
  if (existsSync(dist)) await app.register(fastifyStatic, { root: dist });

  return app;
}

/** Drive a ChargedMatch at `speed` sim-seconds per wall second, 20 frames per second. */
function pump(socket: { on(ev: "close", cb: () => void): unknown }, match: ChargedMatch, speed: number, dtS: number, send: (m: ServerMessage) => unknown): void {
  const ticksPerFrame = Math.max(1, Math.round((speed * 50) / 1000 / dtS));
  const timer = setInterval(() => {
    const events: EngineEvent[] = [];
    const decisions: DecisionNote[] = [];
    for (let i = 0; i < ticksPerFrame && !match.finished; i++) {
      const t = match.tick();
      events.push(...t.events);
      decisions.push(...t.decisions);
    }
    send({
      type: "frame",
      frame: slimFrame(match.state),
      decisions,
      thinking: match.thinking(),
      stats: { decisions: match.decisionsMade, avgLatencyMs: match.decisionsMade ? match.latencySumMs / match.decisionsMade : 0, chargedS: match.chargedS },
    });
    if (match.finished) {
      clearInterval(timer);
      send({ type: "end", score: { red: match.state.score.red.total, blue: match.state.score.blue.total } });
    }
  }, 50);
  socket.on("close", () => clearInterval(timer));
}
