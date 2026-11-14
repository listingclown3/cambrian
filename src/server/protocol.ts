/**
 * WebSocket protocol between the server and the web client (owner: P4, both ends).
 * Types only: this file is imported by the browser bundle.
 */
import type { EngineEvent, Intent, MatchState, RobotId } from "../contracts";

/** One decision as shown in the ticker. Optional fields are present only when the data has them. */
export interface DecisionNote {
  robotId: RobotId;
  timeS: number;
  intent: Intent;
  /** Short stable label of the chosen option (for example "goto_zone:neutral"). */
  label?: string;
  /** Decision latency in ms. For simulated latency this is the charged value, see hello.latencySource. */
  latencyMs?: number;
  /** Probability per option label, only when a provider reported them. Never invented. */
  probabilities?: Record<string, number>;
}

/** Where the data behind a stream comes from. Anything but "live" must be badged on screen. */
export type StreamSource = "demo" | "simulated_latency" | "recorded";

/** Messages the server sends on /ws/demo, /ws/match and /ws/replay. */
export type ServerMessage =
  | {
      /** Sent once when the socket opens. */
      type: "hello";
      /** True while the engine is the stub. */
      engineIsStub: boolean;
      /** True while robots are driven by mock or scripted controllers only. */
      isMock: boolean;
      /** Seed of the match being streamed. */
      seed: number;
      /** Simulated seconds per wall-clock second. */
      speed: number;
      /** What kind of stream this is (absent on the original /ws/demo). */
      source?: StreamSource;
      /** Display name of the decider whose alliance is being charged. */
      decider?: string;
      /** Alliance driven by the decider. */
      deciderAlliance?: "red" | "blue";
      /** Charged decision latency per decision, ms, when latency is simulated. */
      chargedLatencyMs?: number;
      /** Honest one-line description of where latency numbers come from. */
      latencySource?: string;
      /** Run id for recorded replays. */
      runId?: string;
    }
  | {
      /** Sent after every streamed frame. */
      type: "tick";
      /** Full match state after the frame. */
      state: MatchState;
      /** Engine events since the previous tick message. */
      events: EngineEvent[];
      /** Decisions applied since the previous tick message. */
      decisions: DecisionNote[];
      /** Robots whose decision is still "thinking" (their old intent keeps running). */
      thinking?: { robotId: RobotId; untilS: number }[];
      /** Running totals for the top bar. */
      stats?: { decisions: number; avgLatencyMs: number; chargedS: number };
    }
  | {
      /** Sent once when the match is over; the socket stays open. */
      type: "end";
      /** Final totals. */
      score: { red: number; blue: number };
    };

/** One row of GET /api/runs. */
export interface RunListing {
  runId: string;
  /** "runs" for real run folders, "fixture" for bundled fixtures. */
  source: "runs" | "fixture";
  isMock: boolean;
  provider: string | null;
  model: string | null;
  startedTs: string | null;
  seed: number | null;
  decisions: number;
  status: string | null;
}
