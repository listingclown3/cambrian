/**
 * EXPLORATION RACE (owner: P4): animated rollout allocation, uniform search vs Drex-guided search.
 * The race here is an ILLUSTRATIVE SIMULATION on the scenario fixture's authored answer key and Drex priors;
 * the measured numbers (results/headline.json) are shown below it, or "not run yet".
 */
import { useEffect, useMemo, useState } from "react";
import type { Flags } from "../App";
import { NOT_RUN, useApi, type Health, type ScenarioPayload } from "../lib";

export const MAX = 500;

export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/**
 * Sequence of arms pulled until the leader is separated from EVERY other arm (1.5 standard errors, pooled spread
 * estimated from the pulls so far). Uniform = least-pulled arm next; guided = least pulled relative to its prior.
 */
export function search(arms: { mean: number; sd: number }[], prior: number[] | null, noise: number[][]): { pulls: number[]; found: boolean } {
  const k = arms.length;
  const n = new Array<number>(k).fill(0);
  const sum = new Array<number>(k).fill(0);
  const sq = new Array<number>(k).fill(0);
  const pulls: number[] = [];
  for (let t = 0; t < MAX; t++) {
    let pick = 0;
    let bestScore = Infinity;
    for (let i = 0; i < k; i++) {
      const score = (n[i]! + 0.5) / (prior ? 0.1 + 0.9 * prior[i]! : 1);
      if (score < bestScore) { bestScore = score; pick = i; }
    }
    const x = arms[pick]!.mean + arms[pick]!.sd * noise[pick]![n[pick]!]!;
    n[pick]!++;
    sum[pick]! += x;
    sq[pick]! += x * x;
    pulls.push(pick);
    // pooled within-arm variance over arms with at least 2 pulls
    let ss = 0;
    let df = 0;
    for (let i = 0; i < k; i++) if (n[i]! >= 2) { ss += sq[i]! - (sum[i]! * sum[i]!) / n[i]!; df += n[i]! - 1; }
    if (df < 3 || n.some((c) => c < 1)) continue;
    const sp = Math.sqrt(Math.max(ss / df, 0.25));
    const m = arms.map((_, i) => sum[i]! / n[i]!);
    const lead = m.indexOf(Math.max(...m));
    if (n[lead]! < 2) continue;
    const clear = m.every((mi, i) => i === lead || m[lead]! - mi > 1.5 * sp * Math.sqrt(1 / n[lead]! + 1 / n[i]!));
    if (clear) return { pulls, found: true };
  }
  return { pulls, found: false };
}

function Lane({ title, acc, labels, pulls, t, found, bestIdx }: { title: string; acc: string; labels: string[]; pulls: number[]; t: number; found: boolean; bestIdx: number }) {
  const counts = new Array<number>(labels.length).fill(0);
  for (let i = 0; i < Math.min(t, pulls.length); i++) counts[pulls[i]!]!++;
  const done = t >= pulls.length;
  const max = Math.max(1, ...counts);
  return (
    <div className={`card ${acc}`}>
      <div className="decider"><i />{title}</div>
      <div className="counter">{Math.min(t, pulls.length)}</div>
      <div className="hint">{done ? (found ? "rollouts used: best option identified" : `no clear winner within ${MAX} rollouts`) : "rollouts used so far"}</div>
      <div style={{ marginTop: "0.8rem" }}>
        {labels.map((l, i) => (
          <div key={l} className={`rbar ${i === bestIdx && done ? "best" : ""}`}>
            <span className="lbl" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l}</span>
            <span className="track"><span className="fill" style={{ width: `${(counts[i]! / max) * 100}%` }} /></span>
            <span className="mono">{counts[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RacePage({ health, onFlags }: { health: Health | null; onFlags: (f: Flags) => void }) {
  const sc = useApi<ScenarioPayload>("/api/scenarios").data;
  const head = useApi<{ summary: Record<string, number | null | undefined> }>("/api/results/headline").data;
  const [selId, setSelId] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    onFlags({ mock: ["race is an ILLUSTRATIVE SIMULATION on fixture data (authored answer key and Drex priors)", ...(health?.engineIsStub ? ["engine is the STUB"] : [])], recorded: false });
  }, [health?.engineIsStub, onFlags]);

  const scenario = sc?.scenarios.find((s) => s.id === (selId ?? sc.scenarios[0]?.id)) ?? null;
  const setup = useMemo(() => {
    if (!scenario?.answerKey) return null;
    const entries = Object.entries(scenario.answerKey.values);
    const arms = entries.map(([, v]) => ({ mean: v.mean, sd: (v.ci95 * Math.sqrt(v.n)) / 1.96 }));
    const probs = sc?.picks[scenario.id]?.drex?.probabilities;
    const prior = probs ? entries.map(([l]) => probs[l] ?? 0.02) : null;
    const g = rng(run + 1);
    const noise = arms.map(() => Array.from({ length: MAX + 1 }, g));
    const labels = entries.map(([l]) => l);
    return { labels, uniform: search(arms, null, noise), guided: prior ? search(arms, prior, noise) : null, bestIdx: labels.indexOf(scenario.answerKey.best) };
  }, [scenario, sc, run]);

  useEffect(() => {
    setT(0);
    const id = setInterval(() => setT((x) => x + 1), 110);
    return () => clearInterval(id);
  }, [run, scenario?.id]);

  if (!sc) return <div className="empty">loading…</div>;
  const s = head?.summary ?? {};
  const fmt = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(1) : NOT_RUN);
  return (
    <div>
      <h1>Exploration Race</h1>
      <p className="sub">Both searchers must find the best option with the same evidence rule. Drex's probabilities decide where the rollouts go first.</p>
      <div className="controls">
        <select className="btn" value={scenario?.id ?? ""} onChange={(e) => setSelId(e.target.value)}>
          {sc.scenarios.map((x) => <option key={x.id} value={x.id}>{x.flip === "" ? `${x.familyId}: base` : `${x.familyId}: ${x.flip}`}</option>)}
        </select>
        <button className="btn primary" onClick={() => setRun((r) => r + 1)}>Run again</button>
        <span className="pill mock">ILLUSTRATIVE SIMULATION</span>
      </div>
      {setup && setup.guided ? (
        <div className="race">
          <Lane title="Uniform search" acc="" labels={setup.labels} pulls={setup.uniform.pulls} t={t} found={setup.uniform.found} bestIdx={setup.bestIdx} />
          <Lane title="Drex-guided search" acc="drex" labels={setup.labels} pulls={setup.guided.pulls} t={t} found={setup.guided.found} bestIdx={setup.bestIdx} />
        </div>
      ) : (
        <div className="empty">race needs an answer key and Drex probabilities for this scenario: {NOT_RUN}</div>
      )}
      <h2>Measured rollouts to find the best option</h2>
      <div className="grid g4">
        {([
          ["Uniform", "rollouts_to_best_uniform", ""],
          ["Drex-guided", "rollouts_to_best_drex", "drex"],
          ["Giant-guided", "rollouts_to_best_deepinfra", "giant"],
        ] as const).map(([name, key, acc]) => (
          <div key={key} className={`kpi ${acc}`}>
            <div className="lbl">{name}</div>
            <div className={`val ${typeof s[key] === "number" ? "" : "null"}`}>{fmt(s[key])}</div>
          </div>
        ))}
        <div className="kpi drex">
          <div className="lbl">Saved by Drex-guided search</div>
          <div className={`val ${typeof s.rollout_savings_pct_drex_vs_uniform === "number" ? "" : "null"}`}>
            {typeof s.rollout_savings_pct_drex_vs_uniform === "number" ? `${s.rollout_savings_pct_drex_vs_uniform.toFixed(0)}%` : NOT_RUN}
          </div>
        </div>
      </div>
    </div>
  );
}
