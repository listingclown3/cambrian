/**
 * LIVE MATCH page (owner: P4): "Same match. Two deciders." Two lanes side by side (Drex left, the giant right),
 * each with score, four stat tiles, the field (always drawn), and a feed of the last 3 decisions.
 * Streams: recorded replay (P), provider-driven live (R, when keys are present) or a badged simulated-latency fallback.
 */
import { useEffect, useMemo } from "react";
import type { MatchState } from "../../../src/contracts";
import type { Flags } from "../App";
import { FieldCanvas } from "../FieldCanvas";
import { giantLabel, ms, robotName, useApi, type Health, type ProviderRow, type RunListing } from "../lib";
import { stateFromFrame, type MatchView, type TickerRow } from "../matchReducer";
import { useMatch } from "../useMatch";
import type { SlimFrame, SlimStatic } from "../../../src/server/protocol";

/** Latencies for the simulated-latency fallback stream. Drex ~48 ms is the figure from the brief; the giant 3 s is an assumption. */
const DREX_MS = 48;
const GIANT_MS = 3000;
const DEMO_SEED = 7;
const AMBER = "#f5a524";
const CYAN = "#38bdf8";

export interface Launch {
  mode: "live" | "replay";
  n: number;
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
const NOT_RUN_TXT = "not run yet";

function Tile({ label, value, unit }: { label: string; value: string | null; unit?: string }) {
  return (
    <div className="lv-tile">
      <span>{label}</span>
      {value === null ? <b className="lv-null">{NOT_RUN_TXT}</b> : <b className="mono">{value}{unit && <small>{unit}</small>}</b>}
    </div>
  );
}

function Decision({ d, accent }: { d: TickerRow; accent: string }) {
  const p = d.probabilities && d.label ? d.probabilities[d.label] : undefined;
  return (
    <div className="lv-dec" style={{ ["--acc" as string]: accent }}>
      <div className="lv-dec1">
        <b>{robotName(d.robotId)}</b>
        <span className="lv-act">→ {(d.label ?? d.intent.action).replaceAll("_", " ")}</span>
        <span className="mono lv-ms">{d.latencyMs !== undefined ? ms(d.latencyMs) : ""}</span>
      </div>
      {d.why && <div className="lv-why">{d.why}</div>}
      <div className="lv-dec3">
        {p !== undefined && (
          <>
            <span className="lv-track"><i style={{ width: `${Math.round(p * 100)}%` }} /></span>
            <span className="mono">{p.toFixed(2)}</span>
          </>
        )}
        {d.fallback && <span className="lv-fb">FALLBACK POLICY</span>}
      </div>
    </div>
  );
}

function ModelLine({ m, giant }: { m: MatchView; giant: boolean }) {
  const h = m.hello;
  if (!h) return <span className="lv-model">{giant ? giantLabel(null) : "drex-v2.0"}</span>;
  if (h.source === "simulated_latency") return <span className="lv-model">no model called (simulated latency)</span>;
  const model = h.model ?? m.ticker.find((t) => t.model)?.model ?? null;
  return <span className="lv-model">{giant ? giantLabel(model) : (model ?? "model id pending")}</span>;
}

function Badges({ m }: { m: MatchView }) {
  const h = m.hello;
  if (!h) return null;
  return (
    <>
      {h.source === "recorded" && <span className="pill rec">RECORDED</span>}
      {h.source === "provider" && <span className="pill live">LIVE · {h.timing === "realtime" ? "REAL-TIME CLOCK" : "PAUSED CLOCK"}</span>}
      {h.source === "simulated_latency" && <span className="pill mock">SIMULATED LATENCY</span>}
      {h.engineIsStub && <span className="pill mock">STUB ENGINE</span>}
      {h.isMock && h.source !== "simulated_latency" && <span className="pill mock">MOCK</span>}
      {m.status === "error" && m.error && <span className="pill rec">{m.error}</span>}
    </>
  );
}

function Lane({ name, cls, accent, m, idle, giant }: { name: string; cls: "drex" | "giant"; accent: string; m: MatchView; idle: MatchState | null; giant: boolean }) {
  const state = m.state ?? idle;
  const red = m.final?.red ?? state?.score.red.total ?? 0;
  const blue = m.final?.blue ?? state?.score.blue.total ?? 0;
  const has = m.state !== null;
  const simulated = m.hello?.source === "simulated_latency";
  const median = m.stats.medianLatencyMs ?? (simulated ? m.hello?.chargedLatencyMs : undefined);
  const thinking = useMemo(() => m.thinking, [m.thinking]);
  return (
    <section className={`lv-lane ${cls}`} style={{ ["--acc" as string]: accent }}>
      <header className="lv-lh">
        <i className="lv-dot" />
        <div>
          <div className="lv-name">{name}</div>
          <ModelLine m={m} giant={giant} />
        </div>
        <div className="lv-badges"><Badges m={m} /></div>
      </header>
      <div className="lv-score">
        <span className="tagc red">RED</span><b className="mono">{Math.round(red)}</b>
        <span className="lv-vs">vs</span>
        <b className="mono">{Math.round(blue)}</b><span className="tagc blue">BLUE</span>
      </div>
      <div className="lv-tiles">
        <Tile label="decisions" value={has && m.stats.decisions > 0 ? String(m.stats.decisions) : null} />
        <Tile label="median think" value={has && median !== undefined ? ms(median) : null} />
        <Tile label="clock lost thinking" value={has && m.stats.decisions > 0 ? m.stats.chargedS.toFixed(1) : null} unit=" s" />
        <Tile label="fallbacks" value={has && m.stats.decisions > 0 ? String(m.stats.fallbacks ?? 0) : null} />
      </div>
      <div className="lv-field"><FieldCanvas state={state} trails={m.trails} thinking={thinking} accent={accent} captions={false} /></div>
      <div className="lv-feed">
        {m.ticker.slice(0, 3).map((d) => <Decision key={d.n} d={d} accent={accent} />)}
        {m.ticker.length === 0 && <div className="lv-empty">{m.status === "connecting" ? "connecting…" : "no decisions yet"}</div>}
      </div>
    </section>
  );
}

function Legend() {
  return (
    <div className="lv-legend">
      <span><i className="bump red" />RED bumpers</span>
      <span><i className="bump blue" />BLUE bumpers</span>
      <span><b className="mono">T D M H X</b> turret · drum · multilane · hauler · other</span>
      <span><i className="fuel" />fuel</span>
      <span><i className="glow" />active hub</span>
      <span><i className="dots" />path since last decision</span>
    </div>
  );
}

export function LivePage({ launch, health, runs, providers, onFlags }: { launch: Launch; view?: "single" | "split"; health: Health | null; runs: RunListing[]; providers: ProviderRow[]; onFlags: (f: Flags) => void }) {
  const a = useMatch();
  const b = useMatch();
  const { start: startA, stop: stopA } = a;
  const { start: startB, stop: stopB } = b;
  const idleData = useApi<{ statics: SlimStatic; frame: SlimFrame }>("/api/idle").data;
  const idle = useMemo(() => (idleData ? stateFromFrame(idleData.statics, idleData.frame) : null), [idleData]);

  const ready = (id: string) => providers.some((p) => p.id === id && p.implemented && p.keyPresent);
  const providersLoaded = providers.length > 0;
  const recDrex = runs.find((r) => r.source === "runs" && r.runId === "recorded-showcase-drex");
  const recGiant = runs.find((r) => r.source === "runs" && r.runId === "recorded-showcase-giant");
  const url = (r: RunListing) => `/ws/replay?source=${r.source}&run=${encodeURIComponent(r.runId)}&speed=6`;
  const sim = (seed: number, who: string, ms_: number) => `/ws/match?seed=${seed}&speed=4&decider=${who}&latencyMs=${ms_}`;

  useEffect(() => {
    if (!providersLoaded) return;
    const auto = launch.n === 0;
    if (launch.mode === "replay" || (auto && (recDrex || recGiant))) {
      if (recDrex && recGiant) {
        startA(url(recDrex));
        startB(url(recGiant));
        return;
      }
      const run = recDrex ?? recGiant ?? runs.find((r) => r.source === "runs") ?? runs[0];
      if (!run) {
        stopA();
        stopB();
        return;
      }
      if (run.provider === "deepinfra") {
        stopA();
        startB(url(run));
      } else {
        stopB();
        startA(url(run));
      }
      return;
    }
    // Live (R): real providers when keys are present; the auto launch on page load never spends money.
    const realDrex = !auto && ready("drex");
    const realGiant = !auto && ready("deepinfra");
    const seed = DEMO_SEED + (launch.n > 0 ? launch.n : 0);
    startA(realDrex ? `/ws/agents?provider=drex&seed=${seed}&timing=realtime&speed=4` : sim(seed, "Drex", DREX_MS));
    startB(realGiant ? `/ws/agents?provider=deepinfra&seed=${seed}&timing=realtime&speed=4` : sim(seed, "Giant", GIANT_MS));
    // restart only when the launch token or the available data changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.n, launch.mode, runs.length, providersLoaded, Boolean(recDrex), Boolean(recGiant)]);

  const recorded = a.hello?.source === "recorded" || b.hello?.source === "recorded";
  const seed = a.hello?.seed ?? b.hello?.seed ?? null;
  useEffect(() => {
    const reasons: string[] = [];
    const hs = [a.hello, b.hello];
    if (health?.engineIsStub || hs.some((h) => h?.engineIsStub)) reasons.push("engine is the STUB");
    if (hs.some((h) => h?.source === "simulated_latency")) reasons.push("a lane's decision latency is SIMULATED (scripted policy, no provider called)");
    if (hs.some((h) => h?.isMock && h.source !== "recorded" && h.source !== "simulated_latency")) reasons.push("mock provider");
    if (hs.some((h) => h?.source === "recorded" && h.isMock)) reasons.push("recorded fixture (scripted controller, not a provider result)");
    onFlags({ mock: reasons, recorded, seed });
  }, [health?.engineIsStub, a.hello, b.hello, recorded, seed, onFlags]);

  const clockState = a.state ?? b.state ?? idle;
  const left = clockState ? Math.max(0, clockState.rules.matchS - clockState.timeS) : null;
  const phase = !clockState ? "" : clockState.phase === "shift" ? `shift ${clockState.shiftIndex}` : clockState.phase;
  return (
    <div className="lv">
      <div className="lv-top">
        <div>
          <h1 className="lv-title">Same match. Two deciders.</h1>
          <p className="lv-sub">Both get the same state and the same options. The match clock keeps running while a decider thinks.</p>
        </div>
        <div className="lv-clock">
          <div className="lv-ct mono">{left === null ? "-:--" : fmtClock(left)}</div>
          <div className="lv-cp">{phase || "match clock"}</div>
          {clockState && (
            <div className="lv-hubs">
              {(["blue", "red"] as const).map((x) => {
                const h = clockState.hubs[x];
                return (
                  <span key={x} className={`${h.warning ? "warn" : ""} ${h.active ? "on" : "off"}`}>
                    {x.toUpperCase()} HUB {h.warning ? "CLOSING" : h.active ? "ACTIVE" : "INACTIVE"} <b className="mono">{h.timeToShiftS.toFixed(0)}s</b>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="lv-lanes">
        <Lane name="Drex" cls="drex" accent={AMBER} m={a} idle={idle} giant={false} />
        <Lane name="The giant" cls="giant" accent={CYAN} m={b} idle={idle} giant />
      </div>
      <Legend />
    </div>
  );
}
