/** LIVE MATCH page (owner: P4): hero field, decision ticker, top bar, and the Drex vs giant split view. */
import { useEffect, useMemo } from "react";
import type { MatchState } from "../../../src/contracts";
import { FieldCanvas } from "../FieldCanvas";
import { ms, robotName, signed, type Health, type RunListing } from "../lib";
import { useMatch, type MatchView, type TickerRow } from "../useMatch";
import type { Flags } from "../App";

/** Latencies fed to the simulated-latency stream. Drex ~48 ms is the figure from the brief; the giant's 3 s is an assumption. */
const DREX_MS = 48;
const GIANT_MS = 3000;
const DEMO_SEED = 7;

export interface Launch {
  mode: "live" | "replay";
  n: number;
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function Scoreboard({ state, final }: { state: MatchState | null; final: MatchView["final"] }) {
  const red = final?.red ?? state?.score.red.total ?? 0;
  const blue = final?.blue ?? state?.score.blue.total ?? 0;
  const left = state ? Math.max(0, state.rules.matchS - state.timeS) : 0;
  const phase = !state ? "waiting" : state.phase === "shift" ? `shift ${state.shiftIndex}` : state.phase;
  return (
    <div className="scoreboard">
      <div className="team blue">
        <span className="tag">BLUE</span>
        <span className="score">{Math.round(blue)}</span>
      </div>
      <div className="clock">
        <div className="t">{fmtClock(left)}</div>
        <div className="ph">{phase}</div>
      </div>
      <div className="team red">
        <span className="score">{Math.round(red)}</span>
        <span className="tag">RED</span>
      </div>
    </div>
  );
}

function HubTimers({ state }: { state: MatchState | null }) {
  if (!state) return null;
  return (
    <div className="hubs">
      {(["blue", "red"] as const).map((a) => {
        const h = state.hubs[a];
        return (
          <div key={a} className={`hubtimer ${a} ${h.active ? "" : "off"} ${h.warning ? "warn" : ""}`}>
            <span>
              {a.toUpperCase()} HUB · {h.warning ? "CLOSING" : h.active ? "ACTIVE" : "INACTIVE"}
            </span>
            <span className="v">{h.timeToShiftS.toFixed(1)}s</span>
          </div>
        );
      })}
    </div>
  );
}

function DecisionCard({ d, accent }: { d: TickerRow; accent?: string }) {
  const top = d.probabilities ? Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) : null;
  const chosenP = top && d.label ? d.probabilities?.[d.label] : undefined;
  const a = d.robotId.startsWith("R") ? "red" : "blue";
  return (
    <div className={`dec ${a}`} style={accent ? ({ "--acc": accent } as React.CSSProperties) : undefined}>
      <div className="l1">
        <span className="who">{robotName(d.robotId)}</span>
        <span className="what">→ {(d.label ?? d.intent.action).replaceAll("_", " ")}</span>
      </div>
      <div className="l2 mono">
        <span>{d.timeS.toFixed(1)}s</span>
        {chosenP !== undefined && <span>p {chosenP.toFixed(2)}</span>}
        {d.latencyMs !== undefined && <span>{ms(d.latencyMs)}</span>}
      </div>
      {top && (
        <div className="bars">
          {top.map(([k, p]) => (
            <div className="bar" key={k}>
              <span className="lbl">{k}</span>
              <span className="track"><span className="fill" style={{ width: `${Math.round(p * 100)}%` }} /></span>
              <span className="mono">{p.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pills({ m }: { m: MatchView }) {
  const h = m.hello;
  if (!h) return null;
  return (
    <>
      {h.source === "recorded" && <span className="pill rec">RECORDED</span>}
      {h.source === "simulated_latency" && <span className="pill mock">SIMULATED LATENCY</span>}
      {h.engineIsStub && <span className="pill mock">STUB ENGINE</span>}
      {h.isMock && <span className="pill mock">MOCK</span>}
    </>
  );
}

function margin(m: MatchView): number | null {
  if (!m.state) return null;
  return m.state.score.blue.total - m.state.score.red.total;
}

export function LivePage({ launch, view, health, runs, onFlags }: { launch: Launch; view: "single" | "split"; health: Health | null; runs: RunListing[]; onFlags: (f: Flags) => void }) {
  const a = useMatch();
  const b = useMatch();
  const { start: startA, stop: stopA } = a;
  const { start: startB, stop: stopB } = b;

  useEffect(() => {
    if (launch.mode === "replay") {
      const run = runs.find((r) => r.source === "runs") ?? runs[0];
      stopB();
      if (run) startA(`/ws/replay?source=${run.source}&run=${encodeURIComponent(run.runId)}&speed=6`);
      else stopA();
    } else if (view === "split") {
      startA(`/ws/match?seed=${DEMO_SEED}&speed=4&decider=Drex&latencyMs=${DREX_MS}`);
      startB(`/ws/match?seed=${DEMO_SEED}&speed=4&decider=Giant&latencyMs=${GIANT_MS}`);
    } else {
      stopB();
      startA(`/ws/match?seed=${DEMO_SEED + launch.n}&speed=4&decider=Drex&latencyMs=${DREX_MS}`);
    }
    // restart only when the launch token or the view changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.n, launch.mode, view, runs.length]);

  const recorded = a.hello?.source === "recorded";
  useEffect(() => {
    const reasons: string[] = [];
    if (health?.engineIsStub || a.hello?.engineIsStub) reasons.push("engine is the STUB");
    if (a.hello?.source === "simulated_latency") reasons.push("decision latency is SIMULATED (scripted policy, no provider called)");
    if (a.hello?.isMock && !recorded) reasons.push("demo match, not a provider-driven result");
    if (recorded && a.hello?.isMock) reasons.push("recorded fixture (stub engine, scripted controller)");
    onFlags({ mock: reasons, recorded });
  }, [health?.engineIsStub, a.hello, recorded, onFlags]);

  const decider = recorded ? (a.hello?.decider ?? "recorded") : "Drex";

  if (view === "split" && !recorded) {
    const ma = margin(a);
    const mb = margin(b);
    return (
      <div>
        <div className="card versus">
          <div className="drex">
            <div className="cap">Drex margin</div>
            <div className="big acc">{ma === null ? "-" : signed(ma, 0)}</div>
            <div className="cap">clock lost to thinking {a.stats.chargedS.toFixed(1)} s</div>
          </div>
          <div>
            <div className="cap">same seed · same field · same scripted policy</div>
            <div className="big delta">{ma !== null && mb !== null ? `Δ ${signed(ma - mb, 0)}` : "-"}</div>
            <div className="cap">margin gained by thinking {ms(GIANT_MS)} faster per decision (simulated)</div>
          </div>
          <div className="giant">
            <div className="cap">Giant margin</div>
            <div className="big acc">{mb === null ? "-" : signed(mb, 0)}</div>
            <div className="cap">clock lost to thinking {b.stats.chargedS.toFixed(1)} s</div>
          </div>
        </div>
        <div className="split">
          {([["Drex", a, "drex", DREX_MS], ["The giant", b, "giant", GIANT_MS]] as const).map(([name, m, cls, lat]) => (
            <div key={name} className={`lane ${cls}`}>
              <div className="topbar" style={{ marginBottom: 0 }}>
                <div className="decider"><i />{name}</div>
                <Pills m={m} />
              </div>
              <div className="mini">
                <div className="stat"><span>decisions</span><b>{m.stats.decisions}</b></div>
                <div className="stat"><span>charged latency</span><b>{ms(lat)}</b></div>
                <div className="stat"><span>thinking now</span><b>{m.thinking.length}</b></div>
              </div>
              <Scoreboard state={m.state} final={m.final} />
              <div className="field-wrap"><FieldCanvas state={m.state} trails={m.trails} thinking={m.thinking} captions={false} /></div>
              <HubTimers state={m.state} />
              <div className="tickline mono">
                {m.ticker.slice(0, 4).map((d) => (
                  <div key={d.n}>{d.timeS.toFixed(0).padStart(3)}s {robotName(d.robotId)} → {d.label} · {ms(d.latencyMs ?? 0)}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <SingleView m={a} decider={decider} recorded={recorded} accent={decider === "Drex" ? "drex" : "giant"} />;
}

function SingleView({ m, decider, accent, recorded }: { m: MatchView; decider: string; accent: string; recorded: boolean }) {
  const status = useMemo(() => (m.status === "connecting" ? "connecting…" : m.status === "error" ? "server not reachable" : m.status), [m.status]);
  return (
    <div className={`live ${accent}`}>
      <div>
        <div className="topbar">
          <div className="decider"><i />{decider}</div>
          <div className="stat"><span>decisions</span><b>{m.stats.decisions}</b></div>
          <div className="stat"><span>avg latency</span><b>{m.stats.decisions ? ms(m.stats.avgLatencyMs) : "-"}</b></div>
          <div className="stat"><span>clock lost to thinking</span><b>{m.stats.chargedS.toFixed(1)} s</b></div>
          <div className="stat"><span>seed</span><b>{m.hello?.seed ?? "-"}</b></div>
          <Pills m={m} />
          {m.status !== "running" && <span className="pill">{status}</span>}
          {recorded && m.hello?.runId && <span className="hint">run {m.hello.runId}</span>}
        </div>
        <Scoreboard state={m.state} final={m.final} />
        <div className="field-wrap"><FieldCanvas state={m.state} trails={m.trails} thinking={m.thinking} /></div>
        <HubTimers state={m.state} />
      </div>
      <div className="rail">
        <h3>Decisions · newest first</h3>
        <div className="ticker">
          {m.ticker.slice(0, 9).map((d) => <DecisionCard key={d.n} d={d} />)}
          {m.ticker.length === 0 && <div className="empty">no decisions yet</div>}
        </div>
      </div>
    </div>
  );
}
