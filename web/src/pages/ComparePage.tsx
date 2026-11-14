/** COMPARE RUNS (owner: P4): recorded runs side by side, plus the results files on disk. Simple tables. */
import { useEffect, useState } from "react";
import type { RunEvent } from "../../../src/contracts";
import type { Flags } from "../App";
import { Sources } from "../Sources";
import { NOT_RUN, ms, signed, useApi, useResult, usd, type RunListing } from "../lib";

interface ResultRow {
  name: string;
  experiment: string;
  createdTs: string;
  isMock: boolean;
  gitCommit: string;
  rows: number;
}

function summarize(events: RunEvent[]) {
  const decisions = events.filter((e) => e.type === "decision");
  const lat = decisions.map((d) => (d.type === "decision" ? d.meta.latencyMs : 0)).sort((a, b) => a - b);
  const scores = events.filter((e) => e.type === "score");
  const last = scores.at(-1);
  const end = events.find((e) => e.type === "run_end");
  return {
    decisions: decisions.length,
    p50: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
    fallbacks: decisions.filter((d) => d.type === "decision" && d.meta.fallbackUsed).length,
    final: last?.type === "score" ? last.totals : null,
    cost: end?.type === "run_end" ? end.totalCostUsd : null,
    status: end?.type === "run_end" ? end.status : "no run_end line",
  };
}

function RunColumn({ run }: { run: RunListing }) {
  const { data } = useApi<RunEvent[]>(`/api/runs/${run.source}/${encodeURIComponent(run.runId)}/events`);
  const s = data ? summarize(data) : null;
  return (
    <div className="card">
      <div><b>{run.runId}</b> {run.isMock && <span className="pill mock">{run.source === "fixture" ? "FIXTURE" : "MOCK"}</span>}</div>
      <table>
        <tbody>
          <tr><td>Provider / model</td><td className="mono">{run.provider ?? "-"} / {run.model ?? "-"}</td></tr>
          <tr><td>Decisions</td><td className="mono">{s?.decisions ?? "…"}</td></tr>
          <tr><td>Median decision latency</td><td className="mono">{s ? (s.p50 === null ? NOT_RUN : ms(s.p50)) : "…"}</td></tr>
          <tr><td>Fallbacks used</td><td className="mono">{s?.fallbacks ?? "…"}</td></tr>
          <tr><td>Final score (red / blue)</td><td className="mono">{s ? (s.final ? `${s.final.red} / ${s.final.blue}` : NOT_RUN) : "…"}</td></tr>
          <tr><td>Spend</td><td className="mono">{s ? (s.cost === null ? NOT_RUN : s.cost > 0 ? usd(s.cost) : "no paid calls") : "…"}</td></tr>
          <tr><td>Status</td><td>{s?.status ?? "…"}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** results/myrobot.json: margin of the user's robot against each theoretical archetype. Format is tolerated loosely until it is frozen. */
function MyRobotPanel() {
  const { data, error } = useApi<{ isMock?: boolean; rows?: Record<string, unknown>[] }>("/api/results/myrobot");
  const rows = data?.rows ?? [];
  const num = (r: Record<string, unknown>, ...keys: string[]) => keys.map((k) => r[k]).find((v): v is number => typeof v === "number");
  return (
    <>
      <h2>Your robot vs the theoreticals</h2>
      <div className="card scroll">
        {error || rows.length === 0 ? (
          <span className="empty">your robot against each archetype: {NOT_RUN} (results/myrobot.json)</span>
        ) : (
          <table>
            <thead><tr><th>Opponent archetype</th><th>Decider</th><th className="num">Matches</th><th className="num">Margin</th><th className="num">95% CI</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const m = num(r, "meanMargin", "margin", "mean");
                const ci = num(r, "ci95");
                return (
                  <tr key={i}>
                    <td>{String(r.archetype ?? r.opponent ?? r.label ?? i).replaceAll("_", " ")}</td>
                    <td>{String(r.decider ?? "-")}</td>
                    <td className="num mono">{String(r.n ?? "-")}</td>
                    <td className="num mono">{m === undefined ? NOT_RUN : signed(m)}</td>
                    <td className="num mono">{ci === undefined ? "-" : `± ${ci.toFixed(1)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

interface QuirkRule { id: string; page: number; pViolation: number }
interface Quirk {
  id: string;
  title: string;
  source: string;
  value: { marginDiff: number | null; ci95: number | null; n: number | null; reason?: string; firesTotal?: number; g420FoulsOnOpponents?: number; g420FoulsOnUs?: number };
  legality: "LEGAL" | "RISKY" | "ILLEGAL";
  rules: QuirkRule[];
  reliesOnOpponentFouls: number | null;
  notes?: string;
}
const SOURCE_LABEL: Record<string, string> = { lab_proposal: "Strategy Lab proposal", tower_post_up: "Tower post-up", intern_rule_scan: "Intern rule scan" };

/** results/quirks.json: strategy quirks judged against the conduct rules and, where possible, simulated. */
function QuirksPanel() {
  const q = useResult("quirks") as { rows?: Quirk[]; summary?: Record<string, number> } | null;
  const rows = q?.rows ?? [];
  return (
    <>
      <h2>Quirks: legal, risky or illegal?</h2>
      <div className="card scroll">
        {rows.length === 0 ? (
          <span className="empty">quirks {NOT_RUN} (results/quirks.json)</span>
        ) : (
          <table>
            <thead><tr><th>Quirk</th><th>Source</th><th>Legality</th><th className="num">Opponent-foul reliance</th><th>Simulated value</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const top = [...r.rules].sort((a, b) => b.pViolation - a.pViolation)[0];
                const v = r.value;
                return (
                  <tr key={r.id}>
                    <td><b>{r.title}</b>{r.notes && <div className="hint">{r.notes}</div>}</td>
                    <td>{SOURCE_LABEL[r.source] ?? r.source}</td>
                    <td>
                      <span className={r.legality === "LEGAL" ? "ver" : r.legality === "RISKY" ? "todo" : "todo"} style={{ fontWeight: 800 }}>{r.legality}</span>
                      {top && <div className="hint mono">highest: {top.id} (manual p.{top.page}) p {top.pViolation.toFixed(2)}</div>}
                    </td>
                    <td className="num mono">{r.reliesOnOpponentFouls === null ? NOT_RUN : r.reliesOnOpponentFouls.toFixed(2)}</td>
                    <td>
                      {v.marginDiff !== null && v.n !== null ? (
                        <span className="mono">{signed(v.marginDiff)} ± {(v.ci95 ?? 0).toFixed(1)} pts over {v.n} matches</span>
                      ) : (
                        <span className="hint">not simulated: {v.reason ?? NOT_RUN}</span>
                      )}
                      {v.g420FoulsOnOpponents !== undefined && (
                        <div className="hint mono">G420 fouls drawn {v.g420FoulsOnOpponents} · committed {v.g420FoulsOnUs ?? 0}{v.firesTotal !== undefined ? ` · shots fired ${v.firesTotal}` : ""}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

interface IdleSide { policy: string; meanIdleSPerRobotPerMatch: number; maxIdleSPerRobotPerMatch: number; longestIdleStretchS: number }
/** results/idle_report.json: how long robots stood idle before and after the role table. */
function IdlePanel() {
  const r = useResult("idle_report") as { definition?: string; seeds?: number[]; before?: IdleSide; after?: IdleSide } | null;
  const side = (s: IdleSide | undefined, name: string) => (
    <div className="kpi">
      <div className="lbl">{name}</div>
      <div className={`val ${s ? "" : "null"}`}>{s ? `${s.meanIdleSPerRobotPerMatch.toFixed(1)} s` : NOT_RUN}</div>
      <div className="note">{s ? `mean idle per robot per match · worst robot ${s.maxIdleSPerRobotPerMatch.toFixed(1)} s · longest stretch ${s.longestIdleStretchS} s · ${s.policy}` : ""}</div>
    </div>
  );
  return (
    <>
      <h2>No-idle check: before and after</h2>
      <div className="grid g2">{side(r?.before, "Before")}{side(r?.after, "After")}</div>
      {r?.definition && <p className="hint">{r.definition}. {r.seeds ? `${r.seeds.length} seeds.` : ""}</p>}
    </>
  );
}

export function ComparePage({ runs, onFlags }: { runs: RunListing[]; onFlags: (f: Flags) => void }) {
  const results = useApi<ResultRow[]>("/api/results").data ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const anyMock = runs.some((r) => r.isMock) || results.some((r) => r.isMock);
  useEffect(() => onFlags({ mock: anyMock ? ["some listed runs or results are mock or fixture data (badged in the tables)"] : [], recorded: false }), [anyMock, onFlags]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const chosen = runs.filter((r) => picked.includes(`${r.source}/${r.runId}`));

  return (
    <div>
      <h1>Compare Runs</h1>
      <p className="sub">Click up to two recorded runs to compare them side by side.</p>
      <div className="card scroll">
        <table>
          <thead><tr><th>Run</th><th>Source</th><th>Provider</th><th>Model</th><th className="num">Seed</th><th className="num">Decisions</th><th>Status</th></tr></thead>
          <tbody>
            {runs.map((r) => {
              const id = `${r.source}/${r.runId}`;
              return (
                <tr key={id} className={picked.includes(id) ? "sel" : ""} onClick={() => toggle(id)} style={{ cursor: "pointer" }}>
                  <td className="mono">{r.runId}</td>
                  <td>{r.source === "fixture" ? <span className="pill mock">FIXTURE</span> : r.isMock ? <span className="pill mock">MOCK</span> : "runs/"}</td>
                  <td>{r.provider ?? "-"}</td>
                  <td>{r.model ?? "-"}</td>
                  <td className="num mono">{r.seed ?? "-"}</td>
                  <td className="num mono">{r.decisions}</td>
                  <td>{r.status ?? "-"}</td>
                </tr>
              );
            })}
            {runs.length === 0 && <tr><td colSpan={7} className="empty">recorded runs {NOT_RUN}</td></tr>}
          </tbody>
        </table>
      </div>
      {chosen.length > 0 && <div className={`grid g2`} style={{ marginTop: "1rem" }}>{chosen.map((r) => <RunColumn key={`${r.source}/${r.runId}`} run={r} />)}</div>}

      <MyRobotPanel />
      <QuirksPanel />
      <IdlePanel />

      <h2>Results files</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>Experiment</th><th>Written</th><th>Commit</th><th className="num">Rows</th><th>Real?</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td className="mono">{r.createdTs.slice(0, 16).replace("T", " ")}</td>
                <td className="mono">{r.gitCommit}</td>
                <td className="num mono">{r.rows}</td>
                <td>{r.isMock ? <span className="pill mock">MOCK</span> : "real calls"}</td>
              </tr>
            ))}
            {results.length === 0 && <tr><td colSpan={5} className="empty">results {NOT_RUN}</td></tr>}
          </tbody>
        </table>
      </div>
      <Sources files={["quirks", "idle_report", "myrobot", "headline"]} extra={["runs/*/events.jsonl (recorded runs)"]} />
    </div>
  );
}
