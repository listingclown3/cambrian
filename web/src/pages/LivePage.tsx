/** LIVE MATCH page (owner: P4): hero field, decision ticker, top bar, and the Drex vs giant split view. */
import { useEffect, useMemo } from "react";
import type { MatchState } from "../../../src/contracts";
import { FieldCanvas } from "../FieldCanvas";
import { RobotBadge, findTeam, useTeams } from "../RobotBadge";
import { giantLabel, ms, robotName, signed, type Health, type ProviderRow, type RunListing } from "../lib";
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
        {d.fallback && <span className="todo">FALLBACK POLICY</span>}
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
      {h.source === "provider" && <span className="pill live">LIVE PROVIDER · {h.timing === "realtime" ? "REAL-TIME CLOCK" : "PAUSED CLOCK"}</span>}
      {h.source === "simulated_latency" && <span className="pill mock">SIMULATED LATENCY</span>}
      {h.engineIsStub && <span className="pill mock">STUB ENGINE</span>}
      {m.status === "error" && m.error && <span className="pill rec">{m.error}</span>}
      {h.isMock && <span className="pill mock">MOCK</span>}
    </>
  );
}

/** Exact model id (from the stream or the latest decision) plus the giant's reasoning setting. Simulated lanes name no model. */
function ModelPill({ m, giant }: { m: MatchView; giant: boolean }) {
  const h = m.hello;
  if (!h || h.source === "simulated_latency") return h ? <span className="pill mono">no model called</span> : null;
  const model = h.model ?? m.ticker.find((t) => t.model)?.model ?? null;
  if (!giant) return model ? <span className="pill mono">{model}</span> : null;
  return <span className="pill mono">{giantLabel(model)}</span>;
}

function margin(m: MatchView): number | null {
  if (!m.state) return null;
  return m.state.score.blue.total - m.state.score.red.total;
}

export function LivePage({ launch, view, health, runs, providers, onFlags }: { launch: Launch; view: "single" | "split"; health: Health | null; runs: RunListing[]; providers: ProviderRow[]; onFlags: (f: Flags) => void }) {
  const a = useMatch();
  const b = useMatch();
  const { start: startA, stop: stopA } = a;
  const { start: startB, stop: stopB } = b;

  const ready = (id: string) => providers.some((p) => p.id === id && p.implemented && p.keyPresent);
  const drexReal = ready("drex");
  const giantReal = ready("deepinfra");
  const providersLoaded = providers.length > 0;
  /** The recorded showcase pair (same seed, Drex and the giant, real-time clock) played by P. */
  const recDrex = runs.find((r) => r.source === "runs" && r.runId === "recorded-showcase-drex");
  const recGiant = runs.find((r) => r.source === "runs" && r.runId === "recorded-showcase-giant");
  const replayPair = launch.mode === "replay" && Boolean(recDrex && recGiant);
  const drexUrl = (seed: number) => (drexReal ? `/ws/agents?provider=drex&seed=${seed}&timing=realtime&speed=4` : `/ws/match?seed=${seed}&speed=4&decider=Drex&latencyMs=${DREX_MS}`);
  const giantUrl = (seed: number) => (giantReal ? `/ws/agents?provider=deepinfra&seed=${seed}&timing=realtime&speed=4` : `/ws/match?seed=${seed}&speed=4&decider=Giant&latencyMs=${GIANT_MS}`);

  useEffect(() => {
    if (!providersLoaded) return;
    if (launch.mode === "replay") {
      const url = (r: RunListing) => `/ws/replay?source=${r.source}&run=${encodeURIComponent(r.runId)}&speed=6`;
      if (recDrex && recGiant) {
        startA(url(recDrex));
        startB(url(recGiant));
      } else {
        // one recorded showcase run, else any real run, else the bundled fixture (badged RECORDED + MOCK)
        const run = recDrex ?? recGiant ?? runs.find((r) => r.source === "runs") ?? runs[0];
        stopB();
        if (run) startA(url(run));
        else stopA();
      }
    } else if (view === "split") {
      startA(drexUrl(DEMO_SEED));
      startB(giantUrl(DEMO_SEED));
    } else {
      stopB();
      startA(drexUrl(DEMO_SEED + launch.n));
    }
    // restart only when the launch token or the view changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.n, launch.mode, view, runs.length, providersLoaded, Boolean(recDrex), Boolean(recGiant)]);

  const recorded = a.hello?.source === "recorded";
  const splitShown = replayPair || (launch.mode === "live" && view === "split");
  useEffect(() => {
    const reasons: string[] = [];
    const hs = [a.hello, splitShown ? b.hello : null];
    if (health?.engineIsStub || hs.some((h) => h?.engineIsStub)) reasons.push("engine is the STUB");
    if (hs.some((h) => h?.source === "simulated_latency")) reasons.push("a lane's decision latency is SIMULATED (scripted policy, no provider called)");
    if (hs.some((h) => h?.isMock && h.source !== "recorded" && h.source !== "simulated_latency")) reasons.push("mock provider");
    if (recorded && a.hello?.isMock) reasons.push("recorded fixture (scripted controller, not a provider result)");
    onFlags({ mock: reasons, recorded });
  }, [health?.engineIsStub, a.hello, b.hello, splitShown, recorded, onFlags]);

  const rawDecider = a.hello?.decider ?? "Drex";
  const decider = rawDecider === "drex" ? "Drex" : rawDecider === "deepinfra" ? "The giant" : rawDecider;
  const simulated = a.hello?.source === "simulated_latency" || b.hello?.source === "simulated_latency";

  if (splitShown) {
    const bothDone = a.status === "finished" && b.status === "finished";
    const ma = margin(a);
    const mb = margin(b);
    return (
      <div>
        <div className="card versus">
          <div className="drex">
            <div className="cap">{bothDone ? "FINAL · " : ""}Drex margin</div>
            <div className="big acc">{ma === null ? "-" : signed(ma, 0)}</div>
            <div className="cap">clock lost to thinking {a.stats.chargedS.toFixed(1)} s</div>
          </div>
          <div>
            <div className="cap">{replayPair ? "RECORDED · same seed · same field · same scripted opponent" : "same seed · same field · same scripted opponent"}</div>
            <div className="big delta">{ma !== null && mb !== null ? `Δ ${signed(ma - mb, 0)}` : "-"}</div>
            <div className="cap">{replayPair ? "margin difference with each decider's real recorded latency charged to the match clock" : simulated ? `margin difference with ${ms(GIANT_MS)} vs ${ms(DREX_MS)} charged per decision (simulated latency)` : "margin difference with measured latency charged to the match clock"}</div>
          </div>
          <div className="giant">
            <div className="cap">{bothDone ? "FINAL · " : ""}Giant margin</div>
            <div className="big acc">{mb === null ? "-" : signed(mb, 0)}</div>
            <div className="cap">clock lost to thinking {b.stats.chargedS.toFixed(1)} s</div>
          </div>
        </div>
        <div className="split">
          {([["Drex", a, "drex"], ["The giant", b, "giant"]] as const).map(([name, m, cls]) => (
            <div key={name} className={`lane ${cls}`}>
              <div className="topbar" style={{ marginBottom: 0 }}>
                <div className="decider"><i />{name}</div>
                <Pills m={m} />
                <ModelPill m={m} giant={cls === "giant"} />
              </div>
              <div className="mini">
                <div className="stat"><span>decisions</span><b>{m.stats.decisions}</b></div>
                <div className="stat"><span>{m.hello?.source === "simulated_latency" ? "charged latency (simulated)" : "avg latency"}</span><b>{m.hello?.source === "simulated_latency" ? ms(m.hello.chargedLatencyMs ?? 0) : m.stats.decisions ? ms(m.stats.avgLatencyMs) : "-"}</b></div>
                <div className="stat"><span>thinking now</span><b>{m.thinking.length}</b></div>
              </div>
              <Scoreboard state={m.state} final={m.final} />
              <div className="field-wrap"><FieldCanvas state={m.state} trails={m.trails} thinking={m.thinking} captions={false} /></div>
              <HubTimers state={m.state} />
              <div className="tickline mono">
                {m.ticker.slice(0, 4).map((d) => (
                  <div key={d.n}>{d.timeS.toFixed(0).padStart(3)}s {robotName(d.robotId)} → {d.label} · {ms(d.latencyMs ?? 0)}{d.fallback ? " · FALLBACK" : ""}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <SingleView m={a} decider={decider} recorded={recorded} accent={decider === "Drex" ? "drex" : decider === "The giant" ? "giant" : ""} />;
}

function SingleView({ m, decider, accent, recorded }: { m: MatchView; decider: string; accent: string; recorded: boolean }) {
  const teams = useTeams();
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
          <ModelPill m={m} giant={decider === "The giant"} />
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
          {m.ticker.slice(0, 6).map((d) => <DecisionCard key={d.n} d={d} />)}
          {m.ticker.length === 0 && <div className="empty">no decisions yet</div>}
        </div>
        <h3>Robots</h3>
        <div className="robots">
          {m.state?.robots.map((r) => (
            <div className="rrow" key={r.id}>
              <span className={`id ${r.alliance}`}>{r.id}</span>
              <span className="nm">{r.profile.teamLabel}<small>{r.profile.archetype.replaceAll("_", " ")} · {r.alliance.toUpperCase()} · fuel {r.fuelHeld}/{r.profile.capacity}</small></span>
              <RobotBadge team={findTeam(teams, { id: r.profile.id, teamLabel: r.profile.teamLabel })} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
