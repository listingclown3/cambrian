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
import { IMPLEMENTED_PROVIDERS } from "../decide";
import { ENGINE_IS_STUB, engine } from "../engine";
import { MatchRunner, basicCyclePolicy, demoRobots, type RunnerDecision } from "../exec";
import { readUsage, summarizeUsage } from "../ledger";
import { listUnverified, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { streamAgentMatch } from "./agentMatch";
import { ChargedMatch } from "./chargedMatch";
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

  // Replays a recorded run by re-simulating its seed and applying the logged intents. Query: ?source=&run=&speed=
  app.get("/ws/replay", { websocket: true }, (socket, req) => {
    const q = req.query as { source?: string; run?: string; speed?: string };
    const source = q.source === "runs" ? "runs" : "fixture";
    const file = runFile(q.run ?? "", source);
    const send = (m: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    if (!file) return void socket.close(1008, "no such run");
    const events = readRunEvents(file);
    const start = events.find((e) => e.type === "run_start");
    if (!start || start.type !== "run_start") return void socket.close(1008, "run has no run_start");
    const seed = start.manifest.seeds.eval[0] ?? start.manifest.seeds.dev[0] ?? 1;
    // Logged matchTimeS is the sim time the intent was APPLIED (latency already charged). Replay is fully offline:
    // it re-simulates from the seed with the run's own config and applies the logged intents; no provider is called.
    const rcfg = start.manifest.config;
    const speed = Math.min(40, Math.max(1, Number.parseInt(q.speed ?? "", 10) || 6));
    const decisions = events.flatMap((e) =>
      e.type === "decision" && e.intent
        ? [{ robotId: e.robotId, timeS: e.matchTimeS, intent: e.intent, label: e.chosenLabel ?? stepLabel(e.intent), latencyMs: e.meta.latencyMs, fallback: e.meta.fallbackUsed, provider: e.meta.provider, model: e.meta.model, isMock: e.meta.isMock, batch: `${e.matchTimeS}|${e.meta.latencyMs}|${e.request.seed}` }]
        : [],
    );
    decisions.sort((a, b) => a.timeS - b.timeS);
    const state = engine.createMatch(rcfg, seed, demoRobots(rcfg));
    let next = 0;
    let latSum = 0;
    let count = 0;
    let calls = 0;
    const seenBatches = new Set<string>();
    send({
      type: "hello",
      engineIsStub: ENGINE_IS_STUB,
      isMock: start.manifest.isMock || source === "fixture",
      seed,
      speed,
      source: "recorded",
      decider: start.manifest.provider,
      deciderAlliance: rcfg.server.demoDrexAlliance,
      ...(start.manifest.model ? { model: start.manifest.model } : {}),
      timing: rcfg.realtimeLatencyCharging.enabled ? "realtime" : "paused",
      runId: q.run,
    });
    const timer = setInterval(() => {
      const ev: EngineEvent[] = [];
      const dec: DecisionNote[] = [];
      const ticks = Math.max(1, Math.round((speed * 50) / 1000 / rcfg.physics.dtS));
      for (let i = 0; i < ticks && state.phase !== "finished"; i++) {
        const intents: Record<string, DecisionNote["intent"]> = {};
        while (next < decisions.length && decisions[next]!.timeS <= state.timeS + 1e-9) {
          const { batch, ...d } = decisions[next++]!;
          intents[d.robotId] = d.intent;
          dec.push(d);
          count += 1;
          if (!seenBatches.has(batch)) {
            seenBatches.add(batch);
            latSum += d.latencyMs ?? 0; // robots answered by one batched request share one latency
            calls += 1;
          }
        }
        ev.push(...engine.step(state, intents, rcfg.physics.dtS).events);
      }
      send({ type: "tick", state, events: ev, decisions: dec, stats: { decisions: count, avgLatencyMs: calls ? latSum / calls : 0, chargedS: rcfg.realtimeLatencyCharging.enabled ? (latSum * rcfg.realtimeLatencyCharging.latencyScale) / 1000 : 0 } });
      if (state.phase === "finished") {
        clearInterval(timer);
        send({ type: "end", score: { red: state.score.red.total, blue: state.score.blue.total } });
      }
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
      type: "tick",
      state: match.state,
      events,
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
