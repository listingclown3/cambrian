/** Pure match-stream reducer (owner: P4): no DOM, so it is unit-tested headless for per-message cost. */
import type { MatchState } from "../../src/contracts";
import type { DecisionNote, ServerMessage, SlimFrame, SlimStatic } from "../../src/server/protocol";

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
  stats: { decisions: number; avgLatencyMs: number; chargedS: number; medianLatencyMs?: number; fallbacks?: number };
  trails: Record<string, { x: number; y: number }[]>;
  final: { red: number; blue: number } | null;
  error: string | null;
}
export const EMPTY_VIEW: MatchView = { status: "idle", hello: null, state: null, ticker: [], thinking: [], stats: { decisions: 0, avgLatencyMs: 0, chargedS: 0 }, trails: {}, final: null, error: null };
export const TRAIL = 36;
/** The ticker keeps only the newest rows; the page shows 3 to 5. */
export const TICKER_MAX = 6;

/** Rebuild the MatchState-shaped object the renderers use from static + frame (fields the UI never reads are left out). */
export function stateFromFrame(st: SlimStatic, f: SlimFrame): MatchState {
  const byId = new Map(f.robots.map((r) => [r.id, r]));
  return {
    schemaVersion: 1,
    seed: 0,
    rngState: [],
    tick: 0,
    timeS: f.timeS,
    phase: f.phase,
    shiftIndex: f.shiftIndex,
    firstInactiveAlliance: null,
    hubs: f.hubs,
    robots: st.robots.map((r) => ({ id: r.id, alliance: r.alliance, profile: r.profile, pose: byId.get(r.id)!.pose, fuelHeld: byId.get(r.id)!.fuelHeld })),
    fuel: f.fuel,
    score: { red: { total: f.score.red }, blue: { total: f.score.blue } },
    fouls: [],
    field: st.field,
    rules: st.rules,
  } as unknown as MatchState;
}

/** Apply one server message. Cost is proportional to the message, never to the match length. */
export function reduce(v: MatchView, m: ServerMessage, counter: { n: number }, statics: { current: SlimStatic | null }): MatchView {
  if (m.type === "hello") {
    statics.current = m.statics ?? null;
    return { ...EMPTY_VIEW, status: "running", hello: m };
  }
  if (m.type === "error") return { ...v, status: "error", error: m.message };
  if (m.type === "end") return { ...v, status: "finished", final: m.score };
  const state = m.type === "frame" ? (statics.current ? stateFromFrame(statics.current, m.frame) : null) : m.state;
  if (!state) return v;
  const trails = { ...v.trails };
  for (const d of m.decisions) trails[d.robotId] = [];
  for (const r of state.robots) {
    const t = trails[r.id] ?? [];
    const last = t[t.length - 1];
    if (last && Math.abs(last.x - r.pose.x) + Math.abs(last.y - r.pose.y) < 0.05) continue;
    const nt = t.length >= TRAIL ? t.slice(1) : t.slice();
    nt.push({ x: r.pose.x, y: r.pose.y });
    trails[r.id] = nt;
  }
  const fresh = m.decisions.map((d) => ({ ...d, n: counter.n++ }));
  return {
    ...v,
    state,
    trails,
    ticker: fresh.length ? [...fresh.reverse(), ...v.ticker].slice(0, TICKER_MAX) : v.ticker,
    thinking: m.thinking ?? [],
    stats: m.stats ?? { decisions: v.stats.decisions + m.decisions.length, avgLatencyMs: 0, chargedS: 0 },
  };
}
