/** HEADLINE + BUILT WITH page (owner: P4). Numbers come from results/headline.json and the usage ledger; null = "not run yet". */
import { useEffect } from "react";
import type { Flags } from "../App";
import { NOT_RUN, giantLabel, ms, pct, signed, usd, useApi, useResult, type UsageSummary } from "../lib";

type Raw = { isMock?: boolean; summary: Record<string, number | boolean | null | undefined> };
interface Spec {
  key: string;
  label: string;
  fmt: (v: number) => string;
  acc?: "drex" | "giant";
  note?: string;
  huge?: boolean;
  optional?: boolean;
}

const pts = (v: number) => `${signed(v)} pts`;
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
const SECTIONS: { title: string; sub: string; specs: Spec[]; cols: string }[] = [
  {
    title: "1. Real-time sim margin (thinking time on the sim clock)",
    sub: "Average score margin over the opponents when the match clock keeps running while the decider thinks.",
    cols: "g2",
    specs: [
      { key: "live_margin_drex_realtime", label: "Drex: real-time sim margin", fmt: pts, acc: "drex", huge: true },
      { key: "live_margin_deepinfra_realtime", label: "The giant: real-time sim margin", fmt: pts, acc: "giant", huge: true },
      { key: "live_margin_drex_paused", label: "Drex: paused-clock margin", fmt: pts, acc: "drex", note: "match waits while it thinks" },
      { key: "live_margin_deepinfra_paused", label: "The giant: paused-clock margin", fmt: pts, acc: "giant", note: "match waits while it thinks" },
    ],
  },
  {
    title: "2. Latency and throughput",
    sub: "How long one in-match decision takes, and how many simulated matches fit in an hour.",
    cols: "g4",
    specs: [
      { key: "drex_p50_ms", label: "Drex median decision", fmt: ms, acc: "drex" },
      { key: "drex_p95_ms", label: "Drex slowest 5% decision", fmt: ms, acc: "drex" },
      { key: "deepinfra_p50_ms", label: "The giant median decision", fmt: ms, acc: "giant" },
      { key: "latency_ratio_deepinfra_over_drex", label: "The giant is this many times slower", fmt: (v) => `${v.toFixed(0)}x`, huge: true },
      { key: "sim_matches_per_hour_drex", label: "Sim matches per hour, Drex", fmt: (v) => Math.round(v).toLocaleString(), acc: "drex" },
      { key: "sim_matches_per_hour_deepinfra", label: "Sim matches per hour, the giant", fmt: (v) => Math.round(v).toLocaleString(), acc: "giant" },
      { key: "drex_cost_per_1k_usd", label: "Drex cost per 1,000 decisions", fmt: usd, acc: "drex", note: "$0.03 per 1M input tokens, output free" },
      { key: "deepinfra_cost_per_1k_usd", label: "The giant cost per 1,000 decisions", fmt: usd, acc: "giant" },
      { key: "openai_p50_ms", label: "OpenAI median decision", fmt: ms, note: "optional baseline", optional: true },
    ],
  },
  {
    title: "3. Decision quality against the rollout answer key",
    sub: "How often each decider picks the option the rollouts say is best, and how many points it loses when it does not.",
    cols: "g4",
    specs: [
      { key: "top1_drex", label: "Drex picks the best option", fmt: pct, acc: "drex", huge: true },
      { key: "top1_deepinfra", label: "The giant picks the best option", fmt: pct, acc: "giant", huge: true },
      { key: "top1_scripted", label: "Scripted baseline", fmt: pct },
      { key: "top1_random", label: "Random choice", fmt: pct },
      { key: "regret_drex", label: "Drex regret (points lost per pick)", fmt: num, acc: "drex" },
      { key: "regret_deepinfra", label: "The giant regret", fmt: num, acc: "giant" },
      { key: "regret_scripted", label: "Scripted regret", fmt: num },
      { key: "regret_random", label: "Random regret", fmt: num },
      { key: "context_sensitivity_drex", label: "Drex changes its answer when the context flips", fmt: pct, acc: "drex" },
      { key: "context_sensitivity_deepinfra", label: "The giant changes its answer when the context flips", fmt: pct, acc: "giant" },
      { key: "top1_drex_anonymized", label: "Drex with option names hidden", fmt: pct, acc: "drex", note: "it reads descriptions, not names" },
      { key: "top1_openai", label: "OpenAI picks the best option", fmt: pct, note: "optional baseline", optional: true },
    ],
  },
  {
    title: "4. Rollout savings",
    sub: "Rollouts needed to find the best option when a decider's probabilities order the search.",
    cols: "g4",
    specs: [
      { key: "rollout_savings_pct_drex_vs_uniform", label: "Rollouts saved by Drex-guided search", fmt: (v) => `${v.toFixed(0)}%`, acc: "drex", huge: true },
      { key: "rollouts_to_best_drex", label: "Rollouts to best, Drex-guided", fmt: num, acc: "drex" },
      { key: "rollouts_to_best_uniform", label: "Rollouts to best, uniform", fmt: num },
      { key: "rollouts_to_best_deepinfra", label: "Rollouts to best, giant-guided", fmt: num, acc: "giant" },
    ],
  },
  {
    title: "Benchmark size",
    sub: "",
    cols: "g4",
    specs: [
      { key: "n_scenarios", label: "Scenarios", fmt: num },
      { key: "n_families", label: "Scenario families", fmt: num },
      { key: "n_live_seeds", label: "Evaluation seeds", fmt: num },
      { key: "matches_per_sec", label: "Sim matches per second", fmt: num },
    ],
  },
];

function Kpi({ spec, raw }: { spec: Spec; raw: Raw["summary"] }) {
  const v = raw[spec.key];
  const has = typeof v === "number";
  return (
    <div className={`kpi ${spec.acc ?? ""}`}>
      <div className="lbl">{spec.label}</div>
      <div className={`val ${spec.huge ? "huge" : ""} ${has ? "" : "null"}`}>{has ? spec.fmt(v) : NOT_RUN}</div>
      {spec.note && <div className="note">{spec.note}</div>}
    </div>
  );
}

type ToolSummary = UsageSummary["byTool"]["drex"];
const TOOLS: { id: "drex" | "intern" | "ndi" | "deepinfra" | "keenable"; name: string; color: string; what: string; unit: string; pick: (c: ToolSummary) => number | undefined }[] = [
  { id: "drex", name: "Drex", color: "var(--amber)", what: "Every in-match decision, plus rule judging and archetype classification.", unit: "questions answered", pick: (c) => c.counts.questions },
  { id: "intern", name: "Intern", color: "#a8b4c4", what: "The Strategy Lab: proposes strategies and runs one coding task.", unit: "sessions", pick: (c) => c.counts.sessions },
  { id: "ndi", name: "NDI", color: "#a8b4c4", what: "Rules from the official manual with page citations, plus robot profiles and strategy notes.", unit: "manual pages read", pick: (c) => c.counts.pages },
  { id: "deepinfra", name: "DeepInfra", color: "var(--cyan)", what: "The giant baseline, and the model inside Intern.", unit: "calls", pick: (c) => c.calls },
  { id: "keenable", name: "Keenable", color: "#a8b4c4", what: "Web research: team binders, robot reveals, strategy write-ups.", unit: "requests", pick: (c) => c.counts.requests },
];

const BATCH_SIZES: [number, string][] = [[1, "match size"], [3, "match size"], [8, "stress size"], [32, "stress size"]];

/** Batched decisions: ms of call time per decision when N questions about one state go in one call. */
function BatchedBlock({ raw }: { raw: Raw["summary"] }) {
  const val = (n: number, who: "drex" | "giant") => {
    const v = raw[`batch${n}_ms_per_decision_${who}`];
    return typeof v === "number" ? v : null;
  };
  const max = Math.max(1, ...BATCH_SIZES.flatMap(([n]) => [val(n, "drex"), val(n, "giant")]).filter((v): v is number => v !== null));
  return (
    <section>
      <h2>Batched decisions (all robots at one moment)</h2>
      <p className="sub" style={{ marginTop: "-0.4rem" }}>Milliseconds of call time per decision when N questions about one state are answered in one call.</p>
      <div className="card">
        {BATCH_SIZES.map(([n, kind]) => (
          <div key={n} style={{ display: "grid", gridTemplateColumns: "12rem 1fr", gap: "1rem", padding: "0.4rem 0" }}>
            <div><b>{n} {n === 1 ? "question" : "questions"}</b><div className="hint">{kind}</div></div>
            <div>
              {(["drex", "giant"] as const).map((who) => {
                const v = val(n, who);
                return (
                  <div key={who} className={`rbar ${who}`} style={{ gridTemplateColumns: "6rem 1fr 7rem" }}>
                    <span className="lbl acc">{who === "drex" ? "Drex" : "The giant"}</span>
                    <span className="track"><span className="fill" style={{ width: v === null ? "0%" : `${(v / max) * 100}%` }} /></span>
                    <span className="mono">{v === null ? NOT_RUN : ms(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Fallback counts per decider, shown only where a results file actually reports them. */
function FallbackBlock() {
  const files = [useResult("bench_scenarios"), useResult("bench_live"), useResult("bench_batch")];
  const names = ["bench_scenarios", "bench_live", "bench_batch"];
  const rows = files.flatMap((r, i) =>
    Object.entries(r?.summary ?? {})
      .filter(([k, v]) => /fallback/i.test(k) && (typeof v === "number" || (typeof v === "object" && v !== null)))
      .map(([k, v]) => ({ file: names[i]!, key: k, value: typeof v === "number" ? String(v) : JSON.stringify(v) })),
  );
  if (rows.length === 0) return null;
  return (
    <section>
      <h2>Fallbacks per decider</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>Results file</th><th>Counter</th><th>Value</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.file + r.key}><td className="mono">{r.file}</td><td>{r.key.replaceAll("_", " ")}</td><td className="mono">{r.value}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

/** Which giant: exact model id when a results file reports it, else the first-choice id; reasoning mode always shown. */
function GiantIdentity() {
  const giant = useApi<{ fixedModel: string | null; firstChoice: string | null; reasoning: string }>("/api/giant").data;
  const bench = useResult("bench_scenarios");
  const pick = (o: Record<string, unknown> | undefined) => [o?.giantModel, o?.deepinfraModel, (o?.models as Record<string, unknown> | undefined)?.deepinfra, o?.giant_model].find((v): v is string => typeof v === "string");
  const used = pick(bench?.config) ?? pick(bench?.summary);
  const s = (bench?.summary ?? {}) as Record<string, unknown>;
  const on = [s.giantReasoningOn, s.giant_reasoning_on, s.reasoningOn].find((v): v is Record<string, unknown> => typeof v === "object" && v !== null);
  return (
    <div className="card giant" style={{ marginBottom: "1rem", borderTop: "3px solid var(--acc)" }}>
      <b className="acc">The giant: </b>
      <span className="mono">{used ? giantLabel(used) : giantLabel(giant?.fixedModel ?? giant?.firstChoice, giant?.reasoning ?? "off")}</span>
      <span className="hint">
        {used ? " (model reported by the benchmark results)" : " (first-choice model; each run manifest records the exact id used)"}. The main comparison is reasoning off, the giant at its fastest.
      </span>
      {on && (
        <div style={{ marginTop: "0.5rem" }}>
          <b>Separate row, never blended: giant with reasoning ON (fixed 8-scenario subset)</b>
          <div className="mono">{Object.entries(on).map(([k, v]) => `${k.replaceAll("_", " ")}: ${typeof v === "number" ? Number(v.toFixed(3)) : String(v)}`).join(" · ")}</div>
        </div>
      )}
    </div>
  );
}

export function HeadlinePage({ onFlags }: { onFlags: (f: Flags) => void }) {
  const head = useApi<Raw>("/api/results/headline");
  const usage = useApi<UsageSummary>("/api/usage");
  const raw = head.data?.summary ?? {};
  const mock = head.data?.isMock === true || raw.all_real === false;
  useEffect(() => {
    onFlags({ mock: mock ? ["headline results include mock or non-real data"] : [], recorded: false });
  }, [mock, onFlags]);

  return (
    <div>
      <h1>Headline</h1>
      <p className="sub">
        A strategy lab on the team laptop: Drex drives every robot inside the simulator. Anything not measured yet says so.
        {raw.all_real === true ? " All numbers come from real provider calls." : " Real-call status: not fully determined yet."}
      </p>
      {head.error && <div className="empty">headline unavailable: {head.error}</div>}
      <GiantIdentity />
      {SECTIONS.map((sec) => (
        <section key={sec.title}>
          <h2>{sec.title}</h2>
          {sec.sub && <p className="sub" style={{ marginTop: "-0.4rem" }}>{sec.sub}</p>}
          <div className={`grid ${sec.cols}`}>
            {sec.specs.map((s) => (s.optional && typeof raw[s.key] !== "number" ? null : <Kpi key={s.key} spec={s} raw={raw} />))}
            {sec.specs.some((s) => s.key === "drex_cost_per_1k_usd") && (
              <Kpi
                spec={{ key: "cost_ratio", label: "The giant costs this many times more per decision", fmt: (v) => `${v.toFixed(0)}x`, huge: true }}
                raw={{
                  cost_ratio:
                    typeof raw.drex_cost_per_1k_usd === "number" && raw.drex_cost_per_1k_usd > 0 && typeof raw.deepinfra_cost_per_1k_usd === "number"
                      ? raw.deepinfra_cost_per_1k_usd / raw.drex_cost_per_1k_usd
                      : null,
                }}
              />
            )}
          </div>
        </section>
      )).flatMap((el, i) => (SECTIONS[i]!.title.startsWith("2.") ? [el, <BatchedBlock key="batched" raw={raw} />] : [el]))}
      <FallbackBlock />

      <h2>Built with: live tool usage</h2>
      <p className="sub" style={{ marginTop: "-0.4rem" }}>Counted from the usage ledger: real external calls only, mock and cached calls excluded.</p>
      <div className="grid g5">
        {TOOLS.map((t) => {
          const u = usage.data?.byTool[t.id];
          const n = u ? t.pick(u) : undefined;
          const has = typeof n === "number" && n > 0;
          return (
            <div key={t.id} className="kpi tool" style={{ ["--tc" as string]: t.color, ["--acc" as string]: t.color }}>
              <div className="name">{t.name}</div>
              <div className={`val ${has ? "" : "null"}`}>{has ? n.toLocaleString() : NOT_RUN}</div>
              <div className="lbl">{has ? t.unit : ""}</div>
              <div className="what">{t.what}</div>
              {u && u.calls > 0 && <div className="meta mono">{u.calls} calls · spend {usd(u.costUsd)}</div>}
            </div>
          );
        })}
      </div>
      <div className="grid g4" style={{ marginTop: "1rem" }}>
        {([
          ["lab_proposals_total", "Strategy Lab proposals that passed validation", num],
          ["lab_proposals_beating_baseline", "Of those, beating the scripted baseline in sim", num],
          ["keenable_pages", "Web pages saved by research", num],
          ["ndi_rules_verified_pct", "Config constants verified against the manual", (v: number) => `${v.toFixed(0)}%`],
        ] as const).map(([key, label, fmt]) => (
          <Kpi key={key} spec={{ key, label, fmt }} raw={raw} />
        ))}
      </div>
    </div>
  );
}
