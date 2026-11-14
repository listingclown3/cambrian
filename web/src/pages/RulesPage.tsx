/** RULES & SOURCES page (owner: P4): every game/field constant with status and source, conduct rules, research sources, NDI spend. */
import { useEffect } from "react";
import type { Flags } from "../App";
import { Sources } from "../Sources";
import { NOT_RUN, ms, usd, useApi, useResult, type UsageSummary } from "../lib";
import { RobotBadge, useTeams } from "../RobotBadge";

interface Entry {
  value?: unknown;
  status?: string;
  source?: string;
}
type ConfigLike = { game: Record<string, Entry>; field: Record<string, Entry | { _status?: string; _note?: string }> };
interface ConductPayload {
  available: boolean;
  rules?: { exceptions?: string | string[]; id?: string; topic?: string; text?: string; violation?: string; page?: number; quote?: string; citation?: { document?: string; page?: number; quote?: string } }[];
}
interface SourcesPayload {
  available: boolean;
  pages?: number;
  sources?: { url: string; title: string; query?: string; chars?: number }[];
}

const ORDER: Record<string, number> = { TODO_VERIFY_AGAINST_MANUAL: 0, EXTERNAL_SOURCE: 1, VERIFIED: 2 };
const fmtVal = (v: unknown): string => {
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
};
/** Manual page number found in the source citation, when there is one ("p.15", "p. 44"). */
const manualPage = (src: string): string | null => /\bp\.?\s*(\d+)/i.exec(src)?.[1] ?? null;

/** Rule judge: Drex judging incidents against the conduct rules. The metric wording is shown verbatim from the results file. */
function JudgeCard({ file, tier }: { file: string; tier: string }) {
  const r = useResult(file);
  const s = r?.summary as Record<string, unknown> | undefined;
  const n = (k: string) => (typeof s?.[k] === "number" ? (s[k] as number) : null);
  const name = typeof s?.metricName === "string" ? s.metricName : null;
  const agree = n("agreementPct");
  const hit = n("agreeWithDraftLabels");
  const total = n("incidents");
  const med = n("medianLatencyMsPerCall");
  return (
    <div className="kpi drex">
      <div className="lbl">{tier}{typeof s?.model === "string" ? ` · ${s.model}` : ""}</div>
      <div className={`val ${agree === null ? "null" : ""}`}>{agree === null ? NOT_RUN : hit !== null && total !== null ? `${hit} of ${total}` : `${agree.toFixed(0)}%`}</div>
      {name && <div className="note"><b>{name}</b></div>}
      {typeof s?.caveat === "string" && <div className="note">{s.caveat}</div>}
      {s && (
        <div className="note mono">
          {n("incidents") ?? "?"} incidents · {n("rules") ?? "?"} rules{med !== null ? ` · median ${ms(med)} per call` : ""}{n("drexCalls") !== null ? ` · ${n("drexCalls")} calls` : ""}{n("fallbacks") !== null ? ` · ${n("fallbacks")} fallbacks` : ""}
        </div>
      )}
    </div>
  );
}

interface FieldRow { key: string; configPath: string; configValue: number | null; officialValue: number | null; differenceM: number | null; status: string; page?: number }
/** results/field_pack.json: official field values read from the manual drawings vs what the simulator config uses. */
function FieldPack() {
  const r = useResult("field_pack") as { rows?: FieldRow[]; summary?: { official?: number; derived?: number; notFound?: number } } | null;
  const rows = r?.rows ?? [];
  return (
    <>
      <h2>Official field values (field pack)</h2>
      <div className="card scroll" style={{ maxHeight: "24rem", overflowY: "auto" }}>
        {rows.length === 0 ? (
          <span className="empty">field pack {NOT_RUN} (results/field_pack.json)</span>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>{r?.summary?.official ?? 0} official, {r?.summary?.derived ?? 0} derived, {r?.summary?.notFound ?? 0} not found.</p>
            <table>
              <thead><tr><th>Value</th><th>Config path</th><th className="num">Config</th><th className="num">Official</th><th className="num">Difference (m)</th><th>Status</th><th>Page</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.key}>
                    <td className="mono">{x.key}</td>
                    <td className="mono">{x.configPath}</td>
                    <td className="num mono">{x.configValue ?? NOT_RUN}</td>
                    <td className="num mono">{x.officialValue ?? NOT_RUN}</td>
                    <td className="num mono">{x.differenceM ?? "-"}</td>
                    <td className={x.status === "official" ? "ver" : x.status === "notFound" ? "todo" : ""}>{x.status}</td>
                    <td className="mono">{x.page ? `p.${x.page}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

export function RulesPage({ onFlags }: { onFlags: (f: Flags) => void }) {
  const cfg = useApi<ConfigLike>("/api/config").data;
  const conduct = useApi<ConductPayload>("/api/rules/conduct").data;
  const research = useApi<SourcesPayload>("/api/research/sources").data;
  const usage = useApi<UsageSummary>("/api/usage").data;
  const teams = useTeams();
  useEffect(() => onFlags({ mock: [], recorded: false }), [onFlags]);

  const rows = cfg
    ? (["game", "field"] as const).flatMap((sec) =>
        Object.entries(cfg[sec]).flatMap(([k, e]) => {
          const x = e as Entry;
          return x && typeof x === "object" && typeof x.status === "string" ? [{ path: `${sec}.${k}`, value: x.value, status: x.status, source: x.source ?? "" }] : [];
        }),
      ).sort((a, b) => (ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1))
    : [];
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const ndi = usage?.byTool.ndi;

  return (
    <div>
      <h1>Rules &amp; Sources</h1>
      <p className="sub">Where every number in the simulator comes from. Nothing here is hidden: unverified constants are listed first.</p>

      <div className="grid g4">
        <div className="kpi"><div className="lbl">Verified against the manual</div><div className="val ver">{count("VERIFIED")}</div></div>
        <div className="kpi"><div className="lbl">Still to verify</div><div className="val todo">{count("TODO_VERIFY_AGAINST_MANUAL")}</div></div>
        <div className="kpi"><div className="lbl">External source</div><div className="val">{count("EXTERNAL_SOURCE")}</div></div>
        <div className="kpi">
          <div className="lbl">NDI spend on manual extraction</div>
          <div className={`val ${ndi && ndi.calls > 0 ? "" : "null"}`}>{ndi && ndi.calls > 0 ? usd(ndi.costUsd) : NOT_RUN}</div>
          {ndi && ndi.calls > 0 && <div className="note mono">{ndi.counts.docs ?? 0} doc · {ndi.counts.pages ?? 0} pages</div>}
        </div>
      </div>

      <h2>Rule judge (Drex reading the conduct rules)</h2>
      <div className="grid g2">
        <JudgeCard file="rule_judge" tier="Tier 1" />
        <JudgeCard file="rule_judge_drex-latest" tier="Tier 2" />
      </div>

      <h2>Game and field constants</h2>
      <div className="card scroll">
        <table>
          <thead><tr><th>Constant</th><th>Value</th><th>Status</th><th>Manual page</th><th>Source</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path}>
                <td className="mono">{r.path}</td>
                <td className="mono">{fmtVal(r.value)}</td>
                <td className={r.status === "VERIFIED" ? "ver" : r.status === "TODO_VERIFY_AGAINST_MANUAL" ? "todo" : ""}>{r.status.replaceAll("_", " ")}</td>
                <td className="mono">{r.status === "VERIFIED" ? (manualPage(r.source) ? `p.${manualPage(r.source)}` : "cheat sheet") : "-"}</td>
                <td>{r.source}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="empty">config not loaded</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Conduct rules (with page citations)</h2>
      <div className="card scroll">
        {conduct?.available && conduct.rules && conduct.rules.length > 0 ? (
          <table>
            <thead><tr><th>Rule</th><th>Text and penalty</th><th>Manual page</th></tr></thead>
            <tbody>
              {conduct.rules.map((r, i) => (
                <tr key={r.id ?? i}>
                  <td className="mono">{r.id}{r.topic && <div className="hint">{r.topic}</div>}</td>
                  <td>{r.text}{r.violation && <div className="todo" style={{ fontWeight: 600 }}>{r.violation}</div>}
                    {r.exceptions && (Array.isArray(r.exceptions) ? r.exceptions.length > 0 : String(r.exceptions).length > 0) && <div className="hint"><b>Exceptions:</b> {Array.isArray(r.exceptions) ? r.exceptions.join(" ") : String(r.exceptions)}</div>}</td>
                  <td className="mono">{(r.page ?? r.citation?.page) ? `p.${r.page ?? r.citation?.page}` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="empty">conduct rules {NOT_RUN} (data/rules/conduct_rules.json is not there yet)</span>
        )}
      </div>

      <h2>Robot profiles from real team documents {teams?.available ? `(${teams.teams?.length ?? 0})` : ""}</h2>
      <div className="card scroll" style={{ maxHeight: "22rem", overflowY: "auto" }}>
        {teams?.available && teams.teams && teams.teams.length > 0 ? (
          <table>
            <thead><tr><th>Team</th><th>Archetype (classified)</th><th>Provenance (hover for sources)</th></tr></thead>
            <tbody>
              {teams.teams.map((t) => (
                <tr key={t.profile.id ?? t.profile.teamLabel}>
                  <td>{t.profile.teamLabel}</td>
                  <td>{(t.classifiedArchetype?.archetype ?? t.profile.archetype ?? "-").replaceAll("_", " ")}{t.classifiedArchetype ? ` (${Math.round(t.classifiedArchetype.confidence * 100)}%)` : ""}</td>
                  <td><RobotBadge team={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="empty">real team profiles {NOT_RUN}</span>
        )}
      </div>

      <FieldPack />

      <h2>Research sources {research?.available ? `(${research.pages ?? research.sources?.length ?? 0} pages)` : ""}</h2>
      <div className="card scroll" style={{ maxHeight: "22rem", overflowY: "auto" }}>
        {research?.available && research.sources ? (
          <table>
            <thead><tr><th>Page</th><th>Found by</th><th className="num">Chars</th></tr></thead>
            <tbody>
              {research.sources.map((s) => (
                <tr key={s.url}>
                  <td>{s.title}<div className="hint mono">{s.url}</div></td>
                  <td>{s.query}</td>
                  <td className="num mono">{s.chars?.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="empty">research sources {NOT_RUN}</span>
        )}
      </div>
      <Sources files={["rule_judge", "rule_judge_drex-latest", "field_pack", "ingest_rules", "usage"]} extra={["config/default.json (via /api/config)", "data/rules/conduct_rules.json", "data/research/sources.json", "data/league/teams_from_docs.json"]} />
    </div>
  );
}
