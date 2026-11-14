/**
 * SCENARIO EXPLORER (owner: P4): real benchmark data. Gate result and mean-regret table at the top (bench_scenarios),
 * then family -> flips, the snapshot, curated options with descriptions, answer-key bars with 95% CI, each decider's pick
 * and regret. The hand-authored fixture is used only when no real file exists, and then the MOCK banner shows.
 */
import { useEffect, useMemo, useState } from "react";
import type { Flags } from "../App";
import { FieldCanvas } from "../FieldCanvas";
import { NOT_RUN, ms, signed, useApi, useResult, type Health, type ScenarioPayload } from "../lib";
import { Sources } from "../Sources";

const DECIDERS = [
  ["drex", "DREX", "drex"],
  ["deepinfra", "GIANT", "deepinfra"],
  ["scripted", "SCRIPTED", "scripted"],
  ["random", "RANDOM", "random"],
] as const;

interface DeciderSum {
  models?: string[];
  reasoning?: string | null;
  n_scored?: number;
  fallbacks?: number;
  regret?: number | null;
  regret_ci95?: number | null;
  top1?: number | null;
  latency_p50_ms?: number | null;
}
interface Paired {
  n: number;
  mean_diff: number;
  ci95: number;
}
interface Bench {
  summary?: {
    degeneracy_gate?: { pass: boolean; checks: Record<string, { value: number; label?: string; limit: string; pass: boolean; scripted?: number; random_expected?: number }> };
    paired_regret?: Record<string, Paired>;
    deciders?: Record<string, DeciderSum>;
    n_scenarios?: number;
    n_unambiguous?: number;
  };
  rows?: { decider: string; scenarioId: string; chosen: string | null; regret: number | null; fallbackUsed: boolean; latencyMs?: number | null }[];
}

function Gate({ b }: { b: Bench }) {
  const g = b.summary?.degeneracy_gate;
  const d = b.summary?.deciders ?? {};
  const pr = b.summary?.paired_regret?.drex_minus_giant;
  if (!g && !b.summary?.deciders) return <div className="card empty">benchmark results {NOT_RUN}</div>;
  const names: [string, string][] = [["drex", "Drex"], ["deepinfra", "The giant (reasoning off)"], ["scripted", "Scripted"], ["random", "Random"]];
  return (
    <div className="grid g2" style={{ marginBottom: "1rem" }}>
      <div className="card">
        <b>Degeneracy gate: </b>
        {g ? <span className={g.pass ? "ver" : "todo"}>{g.pass ? "PASS" : "FAIL"}</span> : <span className="empty">{NOT_RUN}</span>}
        <p className="hint" style={{ margin: "0.3rem 0 0.5rem" }}>The benchmark is only meaningful if no single option always wins and flipping the context changes the best option.</p>
        {g && (
          <table>
            <tbody>
              {Object.entries(g.checks).map(([k, c]) => (
                <tr key={k}>
                  <td>{k.replaceAll("_", " ")}</td>
                  <td className="mono">{k === "scripted_vs_random_regret" ? `${c.scripted?.toFixed(1)} vs ${c.random_expected?.toFixed(1)}` : c.value.toFixed(2)}</td>
                  <td className="hint">limit {c.limit}</td>
                  <td className={c.pass ? "ver" : "todo"}>{c.pass ? "pass" : "fail"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <b>Mean regret (points lost vs the answer key; lower is better)</b>
        <table>
          <thead><tr><th>Decider</th><th className="num">Regret ± 95% CI</th><th className="num">Scored</th><th className="num">Fallbacks</th></tr></thead>
          <tbody>
            {names.map(([k, n]) => {
              const x = d[k];
              return (
                <tr key={k}>
                  <td className={k === "drex" ? "acc drex" : k === "deepinfra" ? "acc giant" : ""}>{n}</td>
                  <td className="num mono">{x && typeof x.regret === "number" ? `${x.regret.toFixed(1)} ± ${(x.regret_ci95 ?? 0).toFixed(1)}` : NOT_RUN}</td>
                  <td className="num mono">{x?.n_scored ?? "-"}</td>
                  <td className="num mono">{x?.fallbacks ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="hint" style={{ margin: "0.5rem 0 0" }}>
          Paired difference, Drex minus giant: {pr ? <b className="mono">{signed(pr.mean_diff)} ± {pr.ci95.toFixed(1)} (n {pr.n})</b> : NOT_RUN}
          {pr && Math.abs(pr.mean_diff) <= pr.ci95 ? " (within the confidence interval: not a significant difference)" : ""}
        </p>
      </div>
    </div>
  );
}

export function ScenarioPage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  const { data, error } = useApi<ScenarioPayload & { createdTs?: string }>("/api/scenarios");
  const bench = (useResult("bench_scenarios") ?? {}) as Bench;
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const mock: string[] = [];
    if (data?.source === "fixture") mock.push("no real scenario file found: showing the hand-authored FIXTURE (illustration, not a measurement)");
    if (health?.engineIsStub) mock.push("snapshots come from the STUB engine");
    onFlags({ mock, recorded: false });
  }, [data?.source, health?.engineIsStub, onFlags]);

  const scenario = useMemo(() => data?.scenarios.find((s) => s.id === (sel ?? data.scenarios[0]?.id)) ?? null, [data, sel]);
  if (error) return <div className="empty">scenarios unavailable: {error}</div>;
  if (!data) return <div className="empty">loading…</div>;
  if (data.scenarios.length === 0) return <div className="empty">scenarios {NOT_RUN}</div>;

  const key = scenario?.answerKey;
  const rows = key ? Object.entries(key.values).sort((a, b) => b[1].mean - a[1].mean) : [];
  const lo = Math.min(0, ...rows.map(([, v]) => v.mean - v.ci95));
  const hi = Math.max(0, ...rows.map(([, v]) => v.mean + v.ci95));
  const span = hi - lo || 1;
  const at = (v: number) => `${((v - lo) / span) * 100}%`;
  const picks = scenario ? (data.picks[scenario.id] ?? {}) : {};
  const desc = new Map((scenario?.options ?? []).map((o) => [o.label, o.description]));
  const myRows = (bench.rows ?? []).filter((r) => r.scenarioId === scenario?.id);

  return (
    <div>
      <h1>Scenario Explorer</h1>
      <p className="sub">One situation, many contexts. Flip one thing and see whether the best option, and each decider's pick, changes. {data.note}</p>
      <Gate b={bench} />
      <div className="scen">
        <div className="famlist">
          {data.families.map((f) => (
            <div key={f.id}>
              <div className="fam">{f.stickyType.replaceAll("_", " ")}<small>{f.description}</small></div>
              {data.scenarios.filter((s) => s.familyId === f.id).map((s) => (
                <button key={s.id} className={`flip ${scenario?.id === s.id ? "on" : ""}`} onClick={() => setSel(s.id)}>
                  {s.flip === "" ? "Base situation" : s.flip}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div>
          <div className="field-wrap">
            <FieldCanvas state={scenario?.snapshot.state ?? null} focusRobotId={scenario?.focusRobotId} />
          </div>
          {scenario && (
            <>
              <p className="sub" style={{ marginTop: "0.6rem" }}>
                <b>{scenario.flip === "" ? "Base situation" : `What changed: ${scenario.flip}`}</b>
                <br />
                Deciding robot <b>{scenario.focusRobotId}</b> (dashed ring) at {scenario.snapshot.takenAtS.toFixed(0)} s. Blue hub {scenario.snapshot.state.hubs.blue.active ? "ACTIVE" : "INACTIVE"} for {scenario.snapshot.state.hubs.blue.timeToShiftS.toFixed(0)} s.
              </p>
              <div className="card scroll">
                <b>Picks and regret for this scenario</b>
                <table>
                  <thead><tr><th>Decider</th><th>Chose</th><th className="num">Regret</th><th className="num">Think time</th></tr></thead>
                  <tbody>
                    {DECIDERS.map(([id, name, benchId]) => {
                      const r = myRows.find((x) => x.decider === benchId);
                      const label = picks[id]?.label ?? r?.chosen ?? null;
                      return (
                        <tr key={id}>
                          <td className={id === "drex" ? "acc drex" : id === "deepinfra" ? "acc giant" : ""}>{name}</td>
                          <td className="mono">{label ?? (r?.fallbackUsed ? "fallback (no usable answer)" : NOT_RUN)}</td>
                          <td className="num mono">{typeof r?.regret === "number" ? r.regret.toFixed(1) : NOT_RUN}</td>
                          <td className="num mono">{typeof r?.latencyMs === "number" ? ms(r.latencyMs) : NOT_RUN}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Answer key (points margin, 95% CI)</h2>
          {rows.length === 0 && <div className="empty">answer key {NOT_RUN}</div>}
          {rows.map(([label, v]) => {
            const chips = DECIDERS.filter(([id]) => picks[id]?.label === label);
            const dp = picks.drex?.probabilities?.[label];
            return (
              <div key={label} className={`ak ${label === key?.best ? "best" : ""}`}>
                <span className="lbl" title={label}>{label}</span>
                <span className="plot">
                  <span className="barv" style={{ left: at(Math.min(0, v.mean)), width: `${(Math.abs(v.mean) / span) * 100}%` }} />
                  <span className="ci" style={{ left: at(v.mean - v.ci95), width: `${((2 * v.ci95) / span) * 100}%` }} />
                  <span className="zero" style={{ left: at(0) }} />
                </span>
                <span className="mono">{signed(v.mean)}</span>
                {desc.get(label) && <span className="hint" style={{ gridColumn: "2 / -1" }}>{desc.get(label)}</span>}
                {(chips.length > 0 || dp !== undefined) && (
                  <span className="chips">
                    {chips.map(([id, name]) => (
                      <span key={id} className={`chip ${id}`}>{name} PICK{id === "drex" && dp !== undefined ? ` p ${dp.toFixed(2)}` : ""}</span>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          {key && rows.length > 1 && (
            <>
              <div className="plan"><b>Plan A</b> {rows[0]?.[0]} <span className="mono">({signed(rows[0]![1].mean)} ± {rows[0]![1].ci95.toFixed(1)})</span></div>
              <div className="plan"><b>Plan B</b> {rows[1]![0]} <span className="mono">({signed(rows[1]![1].mean)} ± {rows[1]![1].ci95.toFixed(1)})</span></div>
              {key.ambiguous && <p className="hint">Best and runner-up overlap within the confidence interval: this scenario is ambiguous.</p>}
            </>
          )}
        </div>
      </div>
      <Sources files={["scenarios", "bench_scenarios", "answerkey"]} extra={["data/scenarios/scenarios.json (fallback only)"]} />
    </div>
  );
}
