/**
 * EXPLORATION RACE (owner: P4): rollouts needed to find the best option when Drex orders the search, when options
 * are searched in uniform order, and when the giant orders it. Every number comes from results/bench_explore.json;
 * the bar animation only replays those numbers and is labelled illustrative. No file = "not run yet".
 */
import { useEffect, useState } from "react";
import type { Flags } from "../App";
import { NOT_RUN, useResult, type Health } from "../lib";
import { Sources } from "../Sources";

interface Row {
  scenarioId: string;
  ambiguous: boolean;
  nOptions: number;
  best: string;
  drexPosition: number;
  giantPosition: number;
  uniformPosition: number;
  rollouts_drex: number;
  rollouts_deepinfra: number;
  rollouts_uniform: number;
}
interface Agg {
  n: number;
  rollouts_to_best_drex: number;
  rollouts_to_best_deepinfra: number;
  rollouts_to_best_uniform: number;
  rollout_savings_pct_drex_vs_uniform: number;
  rollout_savings_pct_deepinfra_vs_uniform: number;
}

const LANES = [
  { key: "rollouts_uniform", name: "Uniform order", cls: "" },
  { key: "rollouts_drex", name: "Drex-guided order", cls: "drex" },
  { key: "rollouts_deepinfra", name: "Giant-guided order", cls: "giant" },
] as const;

function Summary({ title, a }: { title: string; a: Agg | undefined }) {
  const f = (v: number | undefined) => (typeof v === "number" ? v.toFixed(1) : null);
  const savings = (v: number | undefined) => (typeof v === "number" ? `${v > 0 ? "" : ""}${v.toFixed(1)}%` : null);
  return (
    <div className="card">
      <b>{title}</b> <span className="hint">{a ? `${a.n} scenarios` : ""}</span>
      <div className="grid g3" style={{ marginTop: "0.5rem" }}>
        {([
          ["Uniform", f(a?.rollouts_to_best_uniform), "", null],
          ["Drex-guided", f(a?.rollouts_to_best_drex), "drex", savings(a?.rollout_savings_pct_drex_vs_uniform)],
          ["Giant-guided", f(a?.rollouts_to_best_deepinfra), "giant", savings(a?.rollout_savings_pct_deepinfra_vs_uniform)],
        ] as const).map(([n, v, cls, s]) => (
          <div key={n} className={`kpi ${cls}`}>
            <div className="lbl">{n}</div>
            <div className={`val ${v === null ? "null" : ""}`}>{v ?? NOT_RUN}</div>
            <div className="note">{v !== null ? `rollouts to find the best option${s ? ` · ${s} vs uniform` : ""}` : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RacePage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  const res = useResult("bench_explore") as { isMock?: boolean; summary?: { unambiguous?: Agg; all?: Agg }; rows?: Row[]; config?: { rolloutsPerOption?: number; method?: string } } | null;
  const [selId, setSelId] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [t, setT] = useState(0); // animation progress 0..1

  useEffect(() => {
    const mock: string[] = [];
    if (res?.isMock) mock.push("bench_explore.json is flagged mock");
    if (health?.engineIsStub) mock.push("engine is the STUB");
    onFlags({ mock, recorded: false });
  }, [res?.isMock, health?.engineIsStub, onFlags]);

  useEffect(() => {
    setT(0);
    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      const p = Math.min(1, (performance.now() - t0) / 3500);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [run, selId]);

  const rows = res?.rows ?? [];
  const row = rows.find((r) => r.scenarioId === (selId ?? rows[0]?.scenarioId)) ?? null;
  const max = row ? Math.max(row.rollouts_uniform, row.rollouts_drex, row.rollouts_deepinfra, 1) : 1;

  return (
    <div>
      <h1>Exploration Race</h1>
      <p className="sub">
        How many rollouts does it take to find the best option when a decider's probabilities decide which option to test first?
        {res?.config?.method ? ` ${res.config.method}` : ""}
      </p>
      {!res && <div className="card empty">exploration benchmark {NOT_RUN} (results/bench_explore.json)</div>}
      {res && (
        <>
          <div className="grid g2">
            <Summary title="Unambiguous scenarios" a={res.summary?.unambiguous} />
            <Summary title="All scenarios" a={res.summary?.all} />
          </div>

          <h2>One scenario</h2>
          <div className="controls">
            <select className="btn" value={row?.scenarioId ?? ""} onChange={(e) => setSelId(e.target.value)}>
              {rows.map((r) => <option key={r.scenarioId} value={r.scenarioId}>{r.scenarioId}{r.ambiguous ? " (ambiguous)" : ""}</option>)}
            </select>
            <button className="btn primary" onClick={() => setRun((r) => r + 1)}>Replay animation</button>
            <span className="pill mock">ANIMATION IS ILLUSTRATIVE: the numbers are from the benchmark file</span>
          </div>
          {row && (
            <div className="card">
              <div className="hint">Best option: <b className="mono">{row.best}</b> · {row.nOptions} options · {row.ambiguous ? "ambiguous (runner-up not clearly worse)" : "unambiguous"}</div>
              {LANES.map((l) => (
                <div key={l.key} className={`rbar ${l.cls}`} style={{ gridTemplateColumns: "12rem 1fr 6rem", margin: "0.6rem 0" }}>
                  <span className="lbl acc">{l.name}</span>
                  <span className="track"><span className="fill" style={{ width: `${(row[l.key] / max) * 100 * t}%`, background: l.cls ? "var(--acc)" : "var(--text2)" }} /></span>
                  <span className="mono">{row[l.key]}</span>
                </div>
              ))}
              <div className="hint mono">
                position of the best option in each search order (1 = tested first): uniform {row.uniformPosition} · Drex {row.drexPosition} · giant {row.giantPosition}
              </div>
            </div>
          )}

          <h2>Every scenario</h2>
          <div className="card scroll" style={{ maxHeight: "24rem", overflowY: "auto" }}>
            <table>
              <thead><tr><th>Scenario</th><th className="num">Options</th><th className="num">Uniform</th><th className="num">Drex-guided</th><th className="num">Giant-guided</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.scenarioId} className={r.scenarioId === row?.scenarioId ? "sel" : ""} onClick={() => setSelId(r.scenarioId)} style={{ cursor: "pointer" }}>
                    <td className="mono">{r.scenarioId}{r.ambiguous ? " (ambiguous)" : ""}</td>
                    <td className="num mono">{r.nOptions}</td>
                    <td className="num mono">{r.rollouts_uniform}</td>
                    <td className="num mono">{r.rollouts_drex}</td>
                    <td className="num mono">{r.rollouts_deepinfra}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Sources files={["bench_explore", "scenarios"]} />
    </div>
  );
}
