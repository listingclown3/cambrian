/**
 * MatchRecorder (owner: P2): turns an AgentController match into a RunEvent JSONL log at
 * runs/<runId>/events.jsonl, in the format src/world/worlds/rebuilt/exec/playMatch.ts writes and the server's
 * /ws/replay re-simulates (seed from the manifest, each logged intent applied at the first tick
 * whose time is >= its matchTimeS).
 *
 * Lines: run_start (manifest), decision (agent and scripted robots, in the order they took
 * effect), engine_event / score / foul (as playMatch), run_end.
 *
 * Events are buffered and written when the match ends, so the manifest can name the EXACT model
 * ids that answered (e.g. drex-max-v1.1 for drex-latest, the DeepInfra id chosen at startup).
 * If the run throws, whatever was buffered is still written with run_end status "error".
 */
import { intentLabel, type Config, type EngineEvent, type MatchState, type RunEvent, type RunEventBody } from "../../contracts";
import { RunLogger, buildManifest } from "../../util/runLog";
import { buildActionRequest } from "./ask";
import { decisionRunEvents, type ControllerDecision, type ControllerOptions } from "./controller";

export class MatchRecorder {
  private readonly bodies: RunEventBody[] = [];
  private readonly models = new Set<string>();
  private mock = false;
  private costUsd = 0;

  constructor(
    private readonly cfg: Config,
    readonly seed: number,
    readonly matchId: string,
  ) {}

  /** Hooks to spread into ControllerOptions. */
  hooks(): Pick<ControllerOptions, "onDecision" | "onScriptedDecision" | "onStep" | "onContinuation"> {
    return {
      // Role-continuation intents: logged so a replay reproduces the match, but marked
      // decisionKind "role_continuation" and attributed to no decider.
      onContinuation: ({ robotId, timeS, view, intent }) => {
        this.bodies.push({
          type: "decision",
          isMock: false,
          robotId,
          matchTimeS: timeS,
          request: buildActionRequest(view, this.seed, "offline"),
          meta: { provider: "scripted", model: "role_continuation", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: null, isMock: false },
          chosenLabel: intentLabel(intent),
          intent,
          decisionKind: "role_continuation",
        } as RunEventBody);
      },
      onDecision: (d: ControllerDecision) => {
        for (const m of d.metas) {
          this.models.add(m.model);
          if (m.isMock) this.mock = true;
          if (!m.cached) this.costUsd += m.costUsd;
        }
        this.bodies.push(...decisionRunEvents(d));
      },
      onScriptedDecision: ({ robotId, timeS, policyId, view, intent }) => {
        this.bodies.push({
          type: "decision",
          isMock: false,
          robotId,
          matchTimeS: timeS,
          request: buildActionRequest(view, this.seed, "offline"),
          meta: { provider: "scripted", model: policyId, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, fallbackUsed: false, cached: false, error: null, isMock: false },
          chosenLabel: intentLabel(intent),
          intent,
        });
      },
      onStep: (events: EngineEvent[], state: MatchState) => {
        for (const event of events) {
          this.bodies.push({ type: "engine_event", isMock: false, matchId: this.matchId, event });
          if (event.kind === "score" && event.points !== 0) {
            this.bodies.push({
              type: "score",
              isMock: false,
              matchId: this.matchId,
              matchTimeS: event.timeS,
              alliance: event.alliance,
              points: event.points,
              totals: { red: state.score.red!.total, blue: state.score.blue!.total },
            });
          }
          if (event.kind === "foul") {
            const foul = state.fouls.findLast((f) => f.byRobotId === event.robotId && f.timeS === event.timeS);
            if (foul) this.bodies.push({ type: "foul", isMock: false, matchId: this.matchId, foul });
          }
        }
      },
    };
  }

  /** Exact model ids that answered provider calls, sorted. */
  get servedModels(): string[] {
    return [...this.models].sort();
  }

  /**
   * Write the log. `provider` is the decider spec; `model` defaults to the served model ids.
   * Returns the file path and every line written.
   */
  write(args: { runId: string; provider: string; model?: string; status: "ok" | "error"; durationMs: number; error: string | null; dir?: string; behaviour?: unknown }): { file: string; lines: RunEvent[] } {
    const logger = new RunLogger(args.runId, ...(args.dir ? [args.dir] : []));
    const isDev = this.cfg.seeds.dev.includes(this.seed);
    const isEval = this.cfg.seeds.eval.includes(this.seed);
    const model = args.model ?? (this.servedModels.join(",") || "none");
    const lines: RunEvent[] = [];
    lines.push(
      logger.write({
        type: "run_start",
        isMock: this.mock,
        manifest: buildManifest({
          runId: args.runId,
          cfg: this.cfg,
          // A seed in neither list is logged as dev so the replay can still find it.
          seeds: { dev: isDev || !isEval ? [this.seed] : [], eval: isEval ? [this.seed] : [] },
          provider: args.provider,
          model,
          isMock: this.mock,
        }),
      }),
    );
    for (const b of this.bodies) lines.push(logger.write(b));
    // Extra key "behaviour" (per-decider and per-robot counters), kept as JSON beyond the contract.
    lines.push(logger.write({ type: "run_end", isMock: this.mock, status: args.status, durationMs: args.durationMs, totalCostUsd: this.costUsd, error: args.error, ...(args.behaviour ? { behaviour: args.behaviour } : {}) } as RunEventBody));
    return { file: logger.file, lines };
  }
}
