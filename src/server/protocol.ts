/**
 * WebSocket protocol between the server and the web client (owner: P4, both ends).
 * Types only: this file is imported by the browser bundle.
 */
import type { Alliance, EngineEvent, FieldLayout, FuelPile, HubState, Intent, MatchRules, MatchState, Pose, RobotId, RobotProfile, TrackedBall } from "../contracts";

/** Everything about a match that never changes; sent once in hello so frames stay small. */
export interface SlimStatic {
  field: FieldLayout;
  rules: MatchRules;
  robots: { id: RobotId; alliance: Alliance; profile: RobotProfile }[];
}
/** The per-frame dynamic part of a match: a few KB instead of the full MatchState. */
export interface SlimFrame {
  timeS: number;
  phase: MatchState["phase"];
  shiftIndex: number;
  hubs: Record<Alliance, HubState>;
  score: Record<Alliance, number>;
  robots: { id: RobotId; pose: Pose; fuelHeld: number }[];
  fuel: { byZone: MatchState["fuel"]["byZone"]; piles: FuelPile[]; balls: TrackedBall[] };
}

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
  /** The chosen option's own description from the logged request (never invented). */
  why?: string;
  /** Provider and model that answered, when a provider was asked. */
  provider?: string;
  model?: string;
  /** True when the scripted fallback policy chose instead of the provider. */
  fallback?: boolean;
  /** True when the answer is synthetic (mock provider). */
  isMock?: boolean;
}

/** Where the data behind a stream comes from. Anything but "live" must be badged on screen. */
export type StreamSource = "demo" | "simulated_latency" | "recorded" | "provider";

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
      /** Exact model id of the decider (from the run manifest for replays). */
      model?: string;
      /** Alliance driven by the decider. */
      deciderAlliance?: "red" | "blue";
      /** Charged decision latency per decision, ms, when latency is simulated. */
      chargedLatencyMs?: number;
      /** Honest one-line description of where latency numbers come from. */
      latencySource?: string;
      /** Static match data for slim frames. */
      statics?: SlimStatic;
      /** Provider-driven streams: "paused" or "realtime" latency charging. */
      timing?: "paused" | "realtime";
      /** Provider-driven streams: id of the run being logged to runs/. */
      loggedRunId?: string;
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
      /** Slim per-frame update (used by /ws/match, /ws/agents and /ws/replay). */
      type: "frame";
      frame: SlimFrame;
      decisions: DecisionNote[];
      thinking?: { robotId: RobotId; untilS: number }[];
      stats?: { decisions: number; avgLatencyMs: number; chargedS: number };
    }
  | {
      /** The stream could not start or failed; the message is safe to show (never contains secrets). */
      type: "error";
      message: string;
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
