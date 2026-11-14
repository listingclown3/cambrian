/**
 * WebSocket match stream hook (owner: P4). Incoming messages are queued and applied at most once per
 * animation frame (about 15 per second), so a fast stream never causes more than one React render per frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage, SlimStatic } from "../../src/server/protocol";
import { EMPTY_VIEW, reduce, type MatchView } from "./matchReducer";

export type { Hello, MatchView, TickerRow } from "./matchReducer";
const FLUSH_MS = 66;

/** Returns the view plus start(path) and stop(). `path` is like "/ws/match?seed=3". */
export function useMatch(): MatchView & { start: (path: string) => void; stop: () => void } {
  const [view, setView] = useState<MatchView>(EMPTY_VIEW);
  const sock = useRef<WebSocket | null>(null);
  const counter = useRef({ n: 0 });
  const statics = useRef<{ current: SlimStatic | null }>({ current: null });
  const queue = useRef<ServerMessage[]>([]);
  const raf = useRef(0);
  const lastFlush = useRef(0);
  const live = useRef<MatchView>(EMPTY_VIEW);

  const commit = useCallback((v: MatchView) => {
    live.current = v;
    setView(v);
  }, []);

  const flush = useCallback(() => {
    raf.current = 0;
    const now = performance.now();
    if (now - lastFlush.current < FLUSH_MS) {
      raf.current = requestAnimationFrame(flush);
      return;
    }
    lastFlush.current = now;
    const msgs = queue.current.splice(0);
    if (msgs.length === 0) return;
    let v = live.current;
    for (const m of msgs) v = reduce(v, m, counter.current, statics.current);
    commit(v);
  }, [commit]);

  const stop = useCallback(() => {
    const s = sock.current;
    sock.current = null;
    s?.close();
    queue.current = [];
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  const start = useCallback(
    (path: string) => {
      stop();
      counter.current = { n: 0 };
      statics.current = { current: null };
      commit({ ...EMPTY_VIEW, status: "connecting" });
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
      sock.current = ws;
      ws.onerror = () => sock.current === ws && commit({ ...live.current, status: "error", error: live.current.error ?? "server not reachable" });
      ws.onclose = () => {
        if (sock.current !== ws) return;
        let v = live.current;
        for (const m of queue.current.splice(0)) v = reduce(v, m, counter.current, statics.current);
        commit(v.status === "running" || v.status === "connecting" ? { ...v, status: v.final ? "finished" : "error" } : v);
      };
      ws.onmessage = (raw) => {
        if (sock.current !== ws) return;
        queue.current.push(JSON.parse(raw.data as string) as ServerMessage);
        if (!raf.current) raf.current = requestAnimationFrame(flush);
      };
    },
    [stop, commit, flush],
  );
  useEffect(() => stop, [stop]);
  return { ...view, start, stop };
}
