/** WebSocket match stream hook (owner: P4). Keeps the latest state, a short decision ticker and robot trails. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MatchState } from "../../src/contracts";
import type { DecisionNote, ServerMessage } from "../../src/server/protocol";

export type Hello = Extract<ServerMessage, { type: "hello" }>;
export interface TickerRow extends DecisionNote {
  n: number;
}
export interface MatchView {
  status: "idle" | "connecting" | "running" | "finished" | "error";
  hello: Hello | null;
  state: MatchState | null;
  ticker: TickerRow[];
  thinking: { robotId: string; untilS: number }[];
  stats: { decisions: number; avgLatencyMs: number; chargedS: number };
  trails: Record<string, { x: number; y: number }[]>;
  final: { red: number; blue: number } | null;
  /** Server-reported reason when status is "error". */
  error: string | null;
}
const EMPTY: MatchView = { status: "idle", hello: null, state: null, ticker: [], thinking: [], stats: { decisions: 0, avgLatencyMs: 0, chargedS: 0 }, trails: {}, final: null, error: null };
const TRAIL = 36;

/** Returns the view plus start(path) and stop(). `path` is like "/ws/match?seed=3". */
export function useMatch(): MatchView & { start: (path: string) => void; stop: () => void } {
  const [view, setView] = useState<MatchView>(EMPTY);
  const sock = useRef<WebSocket | null>(null);
  const counter = useRef(0);

  const stop = useCallback(() => {
    const s = sock.current;
    sock.current = null;
    s?.close();
  }, []);

  const start = useCallback(
    (path: string) => {
      stop();
      counter.current = 0;
      setView({ ...EMPTY, status: "connecting" });
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
      sock.current = ws;
      ws.onerror = () => sock.current === ws && setView((v) => ({ ...v, status: "error", error: v.error ?? "server not reachable" }));
      ws.onclose = () => sock.current === ws && setView((v) => (v.status === "running" || v.status === "connecting" ? { ...v, status: v.final ? "finished" : "error" } : v));
      ws.onmessage = (raw) => {
        if (sock.current !== ws) return;
        const m = JSON.parse(raw.data as string) as ServerMessage;
        setView((v) => {
          if (m.type === "hello") return { ...EMPTY, status: "running", hello: m };
          if (m.type === "error") return { ...v, status: "error", error: m.message };
          if (m.type === "end") return { ...v, status: "finished", final: m.score };
          const trails = { ...v.trails };
          for (const r of m.state.robots) {
            const t = (trails[r.id] ?? []).slice(-(TRAIL - 1));
            t.push({ x: r.pose.x, y: r.pose.y });
            trails[r.id] = t;
          }
          const fresh = m.decisions.map((d) => ({ ...d, n: counter.current++ }));
          return {
            ...v,
            state: m.state,
            trails,
            ticker: fresh.length ? [...fresh.reverse(), ...v.ticker].slice(0, 80) : v.ticker,
            thinking: m.thinking ?? [],
            stats: m.stats ?? { decisions: v.stats.decisions + m.decisions.length, avgLatencyMs: 0, chargedS: 0 },
          };
        });
      };
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return { ...view, start, stop };
}
