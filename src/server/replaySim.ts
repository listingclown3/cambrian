/**
 * Offline replay of a recorded run (owner: P4). Re-simulates the seed with the run config and applies the
 * logged intents at their logged (applied) match times. No provider or network call is ever made. Each call to
 * frame() does a bounded slice of simulation (one animation frame of work) and returns one slim message.
 */
import { stepLabel, type Config, type RunEvent } from "../contracts";
import { engine } from "../engine";
import { demoRobots } from "../exec";
import type { DecisionNote, ServerMessage } from "./protocol";
import { slimFrame, slimStatic } from "./slim";

type Logged = DecisionNote & { batch: string };

/** The chosen option description from the logged request: never invented. */
function whyOf(e: Extract<RunEvent, { type: "decision" }>): string | undefined {
  const label = e.chosenLabel;
  if (!label) return undefined;
  const mine = e.request.questions.find((q) => q.id.includes(e.robotId)) ?? e.request.questions[0];
  const opt = (mine?.options ?? e.request.questions.flatMap((q) => q.options ?? [])).find((o) => o.label === label);
  return opt?.description;
}

export class ReplaySim {
  readonly hello: Extract<ServerMessage, { type: "hello" }>;
  private readonly rcfg: Config;
  private readonly decisions: Logged[];
  private readonly state;
  private next = 0;
  private latSum = 0;
  private count = 0;
  private calls = 0;
  private readonly seen = new Set<string>();
  private ended = false;
  private fallbacks = 0;
  private readonly lats: number[] = [];

  constructor(events: RunEvent[], opts: { runId: string; isFixture: boolean; speed: number; engineIsStub: boolean }) {
    const start = events.find((e) => e.type === "run_start");
    if (!start || start.type !== "run_start") throw new Error("run has no run_start");
    this.rcfg = start.manifest.config;
    const seed = start.manifest.seeds.eval[0] ?? start.manifest.seeds.dev[0] ?? 1;
    this.decisions = events
      .flatMap((e) =>
        e.type === "decision" && e.intent
          ? [
              {
                robotId: e.robotId,
                timeS: e.matchTimeS,
                intent: e.intent,
                label: e.chosenLabel ?? stepLabel(e.intent),
                why: whyOf(e),
                latencyMs: e.meta.latencyMs,
                fallback: e.meta.fallbackUsed,
                provider: e.meta.provider,
                model: e.meta.model,
                isMock: e.meta.isMock,
                batch: `${e.matchTimeS}|${e.meta.latencyMs}|${e.request.seed}`,
              } as Logged,
            ]
          : [],
      )
      .sort((a, b) => a.timeS - b.timeS);
    this.state = engine.createMatch(this.rcfg, seed, demoRobots(this.rcfg));
    this.hello = {
      type: "hello",
      engineIsStub: opts.engineIsStub,
      isMock: start.manifest.isMock || opts.isFixture,
      seed,
      speed: opts.speed,
      source: "recorded",
      decider: start.manifest.provider,
      deciderAlliance: this.rcfg.server.demoDrexAlliance,
      ...(start.manifest.model ? { model: start.manifest.model } : {}),
      timing: this.rcfg.realtimeLatencyCharging.enabled ? "realtime" : "paused",
      runId: opts.runId,
      statics: slimStatic(this.state),
    };
  }

  get finished(): boolean {
    return this.state.phase === "finished";
  }

  /** Advance `ticks` engine ticks (bounded work) and return the frame message, plus the end message once. */
  frame(ticks: number): ServerMessage[] {
    const dec: DecisionNote[] = [];
    const dt = this.rcfg.physics.dtS;
    for (let i = 0; i < ticks && !this.finished; i++) {
      const intents: Record<string, DecisionNote["intent"]> = {};
      while (this.next < this.decisions.length && this.decisions[this.next]!.timeS <= this.state.timeS + 1e-9) {
        const { batch, ...d } = this.decisions[this.next++]!;
        intents[d.robotId] = d.intent;
        dec.push(d);
        this.count += 1;
        if (d.fallback) this.fallbacks += 1;
        if (!this.seen.has(batch)) {
          this.seen.add(batch);
          this.lats.push(d.latencyMs ?? 0);
          this.latSum += d.latencyMs ?? 0; // robots answered by one batched request share one latency
          this.calls += 1;
        }
      }
      engine.step(this.state, intents, dt);
    }
    const out: ServerMessage[] = [
      {
        type: "frame",
        frame: slimFrame(this.state),
        decisions: dec,
        stats: {
          decisions: this.count,
          avgLatencyMs: this.calls ? this.latSum / this.calls : 0,
          fallbacks: this.fallbacks,
          ...(this.lats.length ? { medianLatencyMs: [...this.lats].sort((a, b) => a - b)[this.lats.length >> 1]! } : {}),
          chargedS: this.rcfg.realtimeLatencyCharging.enabled ? (this.latSum * this.rcfg.realtimeLatencyCharging.latencyScale) / 1000 : 0,
        },
      },
    ];
    if (this.finished && !this.ended) {
      this.ended = true;
      out.push({ type: "end", score: { red: this.state.score.red.total, blue: this.state.score.blue.total } });
    }
    return out;
  }
}
