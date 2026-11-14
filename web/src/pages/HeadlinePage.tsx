/**
 * RESULTS page (owner: P4): Drex vs the giant at its fastest. Every number comes from a results file
 * (results/headline.json is the single source for the four big cards) or the usage endpoint; null = "not run yet".
 */
import { useEffect } from "react";
import type { Flags } from "../App";
import { Sources } from "../Sources";
import { NOT_RUN, giantLabel, ms, usd, useApi, useResult, type UsageSummary } from "../lib";

type Sum = Record<string, unknown>;
const num = (s: Sum | undefined, k: string): number | null => (typeof s?.[k] === "number" ? (s[k] as number) : null);
const times = (v: number) => `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;

function NotRun() {
  return <span className="rs-null">{NOT_RUN}</span>;
}

function Big({ label, value, detail, acc, sub }: { label: string; value: string | null; detail: string | null; acc: "drex" | "giant" | ""; sub?: string }) {
  return (
    <div className={`rs-card ${acc}`}>
      <div className="rs-lbl">{label}</div>
      <div className="rs-val mono">{value ?? <NotRun />}</div>
      {sub && value !== null && <div className="rs-sub">{sub}</div>}
      <div className="rs-detail">{detail ?? (value === null ? "" : "")}</div>
    </div>
  );
}

const SIZES: [number, string][] = [[1, "match size"], [3, "match size"], [8, "stress size"], [32, "stress size"]];

function Batched({ head, batch }: { head: Sum; batch: Sum }) {
  const val = (n: number, who: "drex" | "giant") => num(head, `batch${n}_ms_per_decision_${who}`) ?? num(batch, `batch${n}_ms_per_decision_${who}`);
  const all = SIZES.flatMap(([n]) => [val(n, "drex"), val(n, "giant")]).filter((v): v is number => v !== null);
  const max = Math.max(1, ...all);
  return (
    <section className="rs-panel">
      <h2>Batched decisions (all robots at one moment)</h2>
      <p className="rs-note">Milliseconds of call time per decision when N questions about one state are answered in one call.</p>
      <div className="rs-chart">
        {SIZES.map(([n, kind]) => (
          <div key={n} className="rs-group">
            <div className="rs-bars">
              {(["drex", "giant"] as const).map((who) => {
                const v = val(n, who);
                return (
                  <div key={who} className={`rs-col ${who}`}>
                    <span className="mono rs-num">{v === null ? <NotRun /> : ms(v)}</span>
                    <span className="rs-bar" style={{ height: v === null ? "0.3rem" : `${Math.max(3, (v / max) * 100)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="rs-glabel"><b className="mono">batch {n}</b><small>{kind}</small></div>
          </div>
        ))}
      </div>
      <div className="rs-legend"><span className="drex">■ Drex</span><span className="giant">■ The giant</span></div>
    </section>
  );
}

function Grounded({ head }: { head: Sum }) {
  const judge = useResult("rule_judge")?.summary as Sum | undefined;
  const scout = useResult("ingest_scouting")?.summary as Sum | undefined;
  const cfg = useApi<{ game: Record<string, { status?: string }>; field: Record<string, { status?: string }> }>("/api/config").data;
  const entries = cfg ? [...Object.values(cfg.game), ...Object.values(cfg.field)].filter((e) => e && typeof e.status === "string") : [];
  const verified = entries.filter((e) => e.status === "VERIFIED").length;
  const lab = { total: num(head, "lab_proposals_total"), beat: num(head, "lab_proposals_beating_baseline") };
  const rows: { name: string; value: string | null; detail: string }[] = [
    {
      name: "Rule calls vs labels",
      value: judge && num(judge, "agreeWithDraftLabels") !== null ? `${num(judge, "agreeWithDraftLabels")} of ${num(judge, "incidents")}` : null,
      detail: typeof judge?.metricName === "string" ? judge.metricName : "Drex judging conduct-rule incidents",
    },
    { name: "NDI scouting fields", value: scout && num(scout, "correct") !== null ? `${num(scout, "correct")} of ${num(scout, "fieldsStated")}` : null, detail: "fields read correctly from messy scouting sheets" },
    { name: "Constants cited to the manual", value: entries.length ? `${verified} of ${entries.length}` : null, detail: "game and field constants verified with a manual page or source" },
    { name: "Lab strategies beating baseline", value: lab.total !== null && lab.beat !== null ? `${lab.beat} of ${lab.total}` : null, detail: "proposed by the Strategy Lab, tested in simulation" },
  ];
  return (
    <section className="rs-panel">
      <h2>Grounded and checked</h2>
      <div className="rs-rows">
        {rows.map((r) => (
          <div key={r.name} className="rs-row">
            <div><b>{r.name}</b><div className="rs-note">{r.detail}</div></div>
            <div className="mono rs-rv">{r.value ?? <NotRun />}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

type ToolSummary = UsageSummary["byTool"]["drex"];
const TOOLS: { id: "drex" | "intern" | "ndi" | "deepinfra" | "keenable"; name: string; color: string; job: string; unit: string; pick: (c: ToolSummary) => number | undefined }[] = [
  { id: "drex", name: "Drex", color: "var(--amber)", job: "Every in-match decision, rule judging and archetype classification.", unit: "questions answered", pick: (c) => c.counts.questions },
  { id: "intern", name: "Intern", color: "var(--text2)", job: "The Strategy Lab: proposes strategies and runs one coding task.", unit: "sessions", pick: (c) => c.counts.sessions },
  { id: "ndi", name: "NDI", color: "var(--text2)", job: "Rules from the official manual with page citations, robot profiles, strategy notes.", unit: "manual pages read", pick: (c) => c.counts.pages },
  { id: "deepinfra", name: "DeepInfra", color: "var(--cyan)", job: "The giant baseline, and the model inside Intern.", unit: "calls", pick: (c) => c.calls },
  { id: "keenable", name: "Keenable", color: "var(--text2)", job: "Web research: team binders, robot reveals, strategy write-ups.", unit: "requests", pick: (c) => c.counts.requests },
];

export function HeadlinePage({ onFlags }: { onFlags: (f: Flags) => void }) {
  const headRes = useApi<{ isMock?: boolean; createdTs?: string; summary: Sum }>("/api/results/headline", 15000);
  const batchRes = useResult("bench_batch", 15000);
  const usage = useApi<UsageSummary>("/api/usage");
  const giant = useApi<{ fixedModel: string | null; firstChoice: string | null; reasoning: string }>("/api/giant").data;
  const head = headRes.data?.summary ?? {};
  const batch = (batchRes?.summary ?? {}) as Sum;
  const mock = headRes.data?.isMock === true || head.all_real === false;
  useEffect(() => {
    onFlags({ mock: mock ? ["results include mock or non-real data"] : [], recorded: false });
  }, [mock, onFlags]);

  // main speed card: per decision, one alliance batched (3 questions per call)
  const b3d = num(head, "batch3_ms_per_decision_drex") ?? num(batch, "batch3_ms_per_decision_drex");
  const b3g = num(head, "batch3_ms_per_decision_giant") ?? num(batch, "batch3_ms_per_decision_giant");
  const ratio = b3d !== null && b3d > 0 && b3g !== null ? b3g / b3d : null;
  const dP50 = b3d;
  const gP50 = b3g;
  const dCost = num(head, "drex_cost_per_1k_usd");
  const gCost = num(head, "deepinfra_cost_per_1k_usd");
  const costRatio = dCost !== null && dCost > 0 && gCost !== null ? gCost / dCost : null;
  const dReg = num(head, "regret_drex");
  const gReg = num(head, "regret_deepinfra");
  const dTop = num(head, "top1_drex");
  const gTop = num(head, "top1_deepinfra");
  const dMph = num(head, "sim_matches_per_hour_drex");
  const gMph = num(head, "sim_matches_per_hour_deepinfra");
  const pc = (v: number | null) => (v === null ? NOT_RUN : `${(v * 100).toFixed(0)}%`);

  return (
    <div className="rs">
      <div className="rs-kicker">RESULTS · DREX VS THE GIANT AT ITS FASTEST</div>
      <h1 className="rs-title">Drex and the giant, measured.</h1>
      <p className="rs-subtitle">
        The giant is <span className="mono">{giantLabel(giant?.fixedModel ?? giant?.firstChoice, giant?.reasoning ?? "off")}</span>: the strongest comparison, at its fastest setting.
        Drex drives every robot inside the simulator on the team laptop.
      </p>
      {headRes.error && <div className="empty">results unavailable: {headRes.error}</div>}

      <div className="rs-cards">
        <Big label="Speed" acc="drex" value={ratio === null ? null : `${times(ratio)} faster`} sub="per decision, one alliance batched (3 questions per call)" detail={dP50 !== null && gP50 !== null ? `Drex ${ms(dP50)} vs the giant ${ms(gP50)} per decision` : null} />
        <Big label="Cost" acc="drex" value={costRatio === null ? null : `${times(costRatio)} cheaper`} detail={dCost !== null && gCost !== null ? `${usd(dCost)} vs ${usd(gCost)} per 1,000 decisions` : null} />
        <Big label="Quality" acc="drex" value={dReg === null ? null : `${dReg.toFixed(2)} pts`} sub="mean regret per decision (lower is better)" detail={gReg !== null || dTop !== null ? `the giant ${gReg === null ? NOT_RUN : `${gReg.toFixed(2)} pts`} · top-1 ${pc(dTop)} vs ${pc(gTop)}` : null} />
        <Big label="Throughput" acc="drex" value={dMph === null ? null : `${Math.round(dMph).toLocaleString()} / hr`} sub="simulated matches per hour" detail={gMph !== null ? `the giant ${Math.round(gMph).toLocaleString()} / hr` : null} />
      </div>

      <div className="rs-two">
        <Batched head={head} batch={batch} />
        <Grounded head={head} />
      </div>

      <section className="rs-panel">
        <h2>Built with</h2>
        <div className="rs-tools">
          {TOOLS.map((t) => {
            const u = usage.data?.byTool[t.id];
            const n = u ? t.pick(u) : undefined;
            const has = typeof n === "number" && n > 0;
            return (
              <div key={t.id} className="rs-tool" style={{ ["--tc" as string]: t.color }}>
                <div className="rs-tn">{t.name}</div>
                <div className="rs-tv mono">{has ? n.toLocaleString() : <NotRun />}</div>
                <div className="rs-tu">{has ? t.unit : ""}</div>
                <div className="rs-note">{t.job}</div>
                {u && u.calls > 0 && <div className="rs-note mono">spend {usd(u.costUsd)}</div>}
              </div>
            );
          })}
        </div>
      </section>
      <Sources files={["headline", "bench_batch", "rule_judge", "ingest_scouting", "lab", "usage"]} extra={["config/default.json (via /api/config)"]} />
    </div>
  );
}
