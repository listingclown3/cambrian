/** SCENARIO EXPLORER (owner: P4): family -> flips, snapshot render, answer-key bars with 95% CI, each decider's pick, Plan A / Plan B. */
import { useEffect, useMemo, useState } from "react";
import type { Flags } from "../App";
import { FieldCanvas } from "../FieldCanvas";
import { NOT_RUN, signed, useApi, type Health, type ScenarioPayload } from "../lib";

const DECIDERS = [
  ["drex", "DREX"],
  ["deepinfra", "GIANT"],
  ["scripted", "SCRIPTED"],
  ["random", "RANDOM"],
] as const;

export function ScenarioPage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  const { data, error } = useApi<ScenarioPayload>("/api/scenarios");
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const mock: string[] = [];
    if (data?.source === "fixture") mock.push("scenario data is a FIXTURE (hand-authored illustration, not a measurement)");
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

  return (
    <div>
      <h1>Scenario Explorer</h1>
      <p className="sub">One situation, many contexts. Flip one thing and see whether the best option, and each decider's pick, changes. {data.note}</p>
      <div className="scen">
        <div className="famlist">
          {data.families.map((f) => (
            <div key={f.id}>
              <div className="fam">{f.stickyType.replaceAll("_", " ")}<small>{f.description}</small></div>
              {data.scenarios.filter((s) => s.familyId === f.id).map((s) => (
                <button key={s.id} className={`flip ${scenario?.id === s.id ? "on" : ""}`} onClick={() => setSel(s.id)}>
                  {s.flip === "" ? "Base situation" : `Flip: ${s.flip}`}
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
            <p className="sub" style={{ marginTop: "0.6rem" }}>
              Deciding robot <b>{scenario.focusRobotId}</b> (dashed ring) at {scenario.snapshot.takenAtS.toFixed(0)} s. Blue hub {scenario.snapshot.state.hubs.blue.active ? "ACTIVE" : "INACTIVE"} for {scenario.snapshot.state.hubs.blue.timeToShiftS.toFixed(0)} s.
            </p>
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
          {key && (
            <>
              <div className="plan"><b>Plan A</b> {rows[0]?.[0]} <span className="mono">({signed(rows[0]![1].mean)} ± {rows[0]![1].ci95.toFixed(1)})</span></div>
              {rows[1] && <div className="plan"><b>Plan B</b> {rows[1][0]} <span className="mono">({signed(rows[1][1].mean)} ± {rows[1][1].ci95.toFixed(1)})</span></div>}
              {key.ambiguous && <p className="hint">Best and runner-up overlap within the confidence interval: this scenario is ambiguous.</p>}
            </>
          )}
          <p className="hint">
            Picks shown: {DECIDERS.filter(([id]) => picks[id]).map(([, n]) => n).join(", ") || NOT_RUN}.
            {data.source === "fixture" && " Drex and giant picks here are illustrative, not measured."}
          </p>
        </div>
      </div>
    </div>
  );
}
