/**
 * WebSocket protocol between the server and the web client (owner: P4, both ends).
 * Types only: this file is imported by the browser bundle.
 */
import type { EngineEvent, Intent, MatchState, RobotId } from "../contracts";

/** Messages the server sends on /ws/demo. */
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
    }
  | {
      /** Sent after every streamed frame. */
      type: "tick";
      /** Full match state after the frame. */
      state: MatchState;
      /** Engine events since the previous tick message. */
      events: EngineEvent[];
      /** Decisions applied since the previous tick message. */
      decisions: { robotId: RobotId; timeS: number; intent: Intent }[];
    }
  | {
      /** Sent once when the match is over; the socket stays open. */
      type: "end";
      /** Final totals. */
      score: { red: number; blue: number };
    };
