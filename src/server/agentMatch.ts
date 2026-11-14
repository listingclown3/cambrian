/**
 * Provider-driven match stream (owner: P4): plays one match with AgentController where one alliance
 * is decided by a real provider (Drex or the DeepInfra giant) and the other is scripted. Latency is
 * charged to the match clock ("realtime") or the match waits ("paused"). The match is logged to
 * runs/<runId>/events.jsonl so it can be replayed with P. Real calls land in the usage ledger.
 */
import { stepLabel, type Alliance, type Config, type DecisionMeta, type DecisionRequest, type MatchState } from "../contracts";
import { AgentController, actionQuestionId, getProvider, type ControllerDecision } from "../decide";
import { engine } from "../engine";
import { basicCyclePolicy, demoRobots } from "../exec";
import { RunLogger, buildManifest, newRunId } from "../util/runLog";
import type { DecisionNote, ServerMessage } from "./protocol";
import { slimFrame, slimStatic } from "./slim";

export interface AgentStreamOptions {
  provider: "drex" | "deepinfra";
  seed: number;
  timing: "paused" | "realtime";
  /** Simulated seconds per wall second cap (frames are only sent this fast). */
  speed: number;
  /** Alliance the provider decides for. */
  alliance: Alliance;
  /** Write runs/<id>/events.jsonl. */
  log: boolean;
}

/** Why a provider cannot be used right now, or null when it can. Never includes key values. */
export function providerUnavailable(cfg: Config, id: "drex" | "deepinfra"): string | null {
  const p = cfg.providers.byId[id];
  if (p.apiKeyEnv !== null && !process.env[p.apiKeyEnv]) return `no API key for ${id} (set ${p.apiKeyEnv} in .env)`;
  return null;
}

let active = 0;

/** Starts the stream; returns a stop function. Frames go through `send`, which must ignore closed sockets. */
export function streamAgentMatch(cfg: Config, o: AgentStreamOptions, send: (m: ServerMessage) => void): () => void {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  if (active >= 2) {
    send({ type: "error", message: "two provider-driven matches are already running" });
    return stop;
  }
  const unavailable = providerUnavailable(cfg, o.provider);
  if (unavailable) {
    send({ type: "error", message: unavailable });
    return stop;
  }

  const base = getProvider(o.provider, cfg);
  // Capture each answer's probabilities so the ticker can show them (the controller keeps only labels).
  const probs = new Map<string, Record<string, number>>();
  const provider = {
    id: base.id,
    async decide(req: DecisionRequest) {
      const res = await base.decide(req);
      for (const [qid, a] of Object.entries(res.answers)) if (a.probabilities) probs.set(qid, a.probabilities);
      return res;
    },
  };

  const runId = newRunId(`live-${o.provider}`);
  const logger = o.log ? new RunLogger(runId) : null;
  const decider = o.provider === "drex" ? "Drex" : "The giant";
  const notes: DecisionNote[] = [];
  let decisions = 0;
  let latSum = 0;
  let calls = 0;
  let chargedS = 0;
  let anyMock = false;
  const onDecision = (d: ControllerDecision) => {
    const meta: DecisionMeta | undefined = d.metas[0];
    if (d.kind !== "intent" || d.alliance !== o.alliance) return;
    calls += d.metas.length;
    latSum += d.latencyMs;
    chargedS += d.chargedS;
    if (d.metas.some((m) => m.isMock)) anyMock = true;
    for (const c of d.choices) {
      if (!c.intent) continue;
      decisions += 1;
      const p = probs.get(actionQuestionId(c.robotId));
      notes.push({
        robotId: c.robotId,
        timeS: d.appliedAtS ?? d.requestedAtS,
        intent: c.intent,
        latencyMs: d.latencyMs,
        fallback: c.usedFallbackPolicy,
        label: c.usedFallbackPolicy ? stepLabel(c.intent) : (c.chosenLabel ?? stepLabel(c.intent)),
        ...(meta ? { provider: meta.provider, model: meta.model, isMock: meta.isMock } : {}),
        ...(p ? { probabilities: p } : {}),
      });
      if (logger && d.requests[0] && meta && d.appliedAtS !== null) {
        logger.write({ type: "decision", isMock: meta.isMock, robotId: c.robotId, matchTimeS: d.appliedAtS ?? d.requestedAtS, request: d.requests[0], meta, chosenLabel: c.usedFallbackPolicy ? stepLabel(c.intent) : c.chosenLabel, intent: c.intent });
      }
    }
  };

  const logCfg: Config = { ...cfg, realtimeLatencyCharging: { ...cfg.realtimeLatencyCharging, enabled: o.timing === "realtime" } };
  const ctl = new AgentController({
    engine,
    cfg: logCfg,
    seed: o.seed,
    robots: demoRobots(cfg),
    agents: { [o.alliance]: { provider } },
    scripted: { default: basicCyclePolicy },
    timing: o.timing,
    onDecision,
  });
  const state: MatchState = ctl.state;
  logger?.write({
    type: "run_start",
    isMock: false,
    manifest: buildManifest({
      runId,
      cfg: logCfg,
      seeds: cfg.seeds.eval.includes(o.seed) ? { dev: [], eval: [o.seed] } : { dev: [o.seed], eval: [] },
      provider: o.provider,
      model: cfg.providers.byId[o.provider].model ?? o.provider,
      isMock: false,
    }),
  });
  send({ type: "hello", engineIsStub: false, isMock: false, seed: o.seed, speed: o.speed, source: "provider", decider, ...(cfg.providers.byId[o.provider].model ? { model: cfg.providers.byId[o.provider].model! } : {}), deciderAlliance: o.alliance, timing: o.timing, statics: slimStatic(state), ...(logger ? { loggedRunId: runId } : {}) });

  active += 1;
  const started = performance.now();
  void (async () => {
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    const last = { red: 0, blue: 0 };
    let lastSend = 0;
    try {
      while (!stopped && !ctl.finished) {
        const wall0 = performance.now();
        const t0 = state.timeS;
        await ctl.tick();
        for (const a of ["red", "blue"] as const) {
          const total = state.score[a].total;
          if (logger && total !== last[a]) {
            logger.write({ type: "score", isMock: false, matchId: runId, matchTimeS: state.timeS, alliance: a, points: total - last[a], totals: { red: state.score.red.total, blue: state.score.blue.total } });
          }
          last[a] = total;
        }
        // Pace to `speed` simulated seconds per wall second; provider waits already count as wall time.
        const sleepMs = ((state.timeS - t0) / o.speed) * 1000 - (performance.now() - wall0);
        const now = performance.now();
        if (now - lastSend >= 50 || ctl.finished) {
          lastSend = now;
          const fresh = notes.splice(0);
          send({ type: "frame", frame: slimFrame(state), decisions: fresh, stats: { decisions, avgLatencyMs: calls ? latSum / calls : 0, chargedS } });
        }
        if (sleepMs > 2) await new Promise((r) => setTimeout(r, sleepMs));
      }
      if (ctl.finished) send({ type: "end", score: { red: state.score.red.total, blue: state.score.blue.total } });
    } catch (e) {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
      send({ type: "error", message: `match failed: ${error.slice(0, 200)}` });
    } finally {
      active -= 1;
      logger?.write({ type: "run_end", isMock: anyMock, status: stopped && !ctl.finished ? "aborted_user" : status, durationMs: performance.now() - started, totalCostUsd: 0, error });
    }
  })();
  return stop;
}
