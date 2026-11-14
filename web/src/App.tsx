/**
 * Web client shell (owner: P4): nav, keyboard (1-6 pages, R live match, P recorded replay, V split view),
 * and the honesty banners. Strategy lab framing: this runs on the team's laptop; Drex drives every robot
 * inside the simulator.
 */
import { useCallback, useEffect, useState } from "react";
import { useApi, type Health, type RunListing } from "./lib";
import { ComparePage } from "./pages/ComparePage";
import { HeadlinePage } from "./pages/HeadlinePage";
import { LivePage, type Launch } from "./pages/LivePage";
import { RacePage } from "./pages/RacePage";
import { RulesPage } from "./pages/RulesPage";
import { ScenarioPage } from "./pages/ScenarioPage";

export interface Flags {
  mock: string[];
  recorded: boolean;
}
const NONE: Flags = { mock: [], recorded: false };

const PAGES = [
  { key: "1", id: "live", label: "Live Match" },
  { key: "2", id: "headline", label: "Headline + Built With" },
  { key: "3", id: "scenarios", label: "Scenario Explorer" },
  { key: "4", id: "race", label: "Exploration Race" },
  { key: "5", id: "compare", label: "Compare Runs" },
  { key: "6", id: "rules", label: "Rules & Sources" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

export function App() {
  const [page, setPage] = useState<PageId>(() => PAGES.find((p) => location.hash.slice(1).split(",").includes(p.id))?.id ?? "live");
  const [view, setView] = useState<"single" | "split">(() => (location.hash.includes("split") ? "split" : "single"));
  const [launch, setLaunch] = useState<Launch>({ mode: "live", n: 0 });
  const [flags, setFlags] = useState<Record<string, Flags>>({});
  const health = useApi<Health>("/api/health").data;
  const runs = useApi<RunListing[]>("/api/runs").data ?? [];

  const reportLive = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.live) === JSON.stringify(f) ? prev : { ...prev, live: f })), []);
  const reportHeadline = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.headline) === JSON.stringify(f) ? prev : { ...prev, headline: f })), []);
  const reportScenarios = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.scenarios) === JSON.stringify(f) ? prev : { ...prev, scenarios: f })), []);
  const reportRace = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.race) === JSON.stringify(f) ? prev : { ...prev, race: f })), []);
  const reportCompare = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.compare) === JSON.stringify(f) ? prev : { ...prev, compare: f })), []);
  const reportRules = useCallback((f: Flags) => setFlags((prev) => (JSON.stringify(prev.rules) === JSON.stringify(f) ? prev : { ...prev, rules: f })), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const p = PAGES.find((x) => x.key === k);
      if (p) setPage(p.id);
      else if (k === "r") {
        setPage("live");
        setLaunch((l) => ({ mode: "live", n: l.n + 1 }));
      } else if (k === "p") {
        setPage("live");
        setLaunch((l) => ({ mode: "replay", n: l.n + 1 }));
      } else if (k === "v") setView((v) => (v === "single" ? "split" : "single"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const f = flags[page] ?? NONE;
  return (
    <div className="app">
      <nav className="nav">
        <span className="brand">DREX <b>STRATEGY LAB</b></span>
        {PAGES.map((p) => (
          <button key={p.id} className={`tab ${page === p.id ? "on" : ""}`} onClick={() => setPage(p.id)}>
            <kbd>{p.key}</kbd>{p.label}
          </button>
        ))}
        <span className="grow" />
        <span className="hint">R live · P recorded replay · V split view</span>
      </nav>
      {f.recorded && (
        <div className="banner recorded">RECORDED <span className="why">this is a replay of a logged run, not a live match</span></div>
      )}
      {f.mock.length > 0 && (
        <div className="banner mock">
          MOCK DATA ON SCREEN <span className="why">{f.mock.join(" · ")}</span>
        </div>
      )}
      <main>
        {page === "live" && <LivePage launch={launch} view={view} health={health} runs={runs} onFlags={reportLive} />}
        {page === "headline" && <HeadlinePage onFlags={reportHeadline} />}
        {page === "scenarios" && <ScenarioPage health={health} onFlags={reportScenarios} />}
        {page === "race" && <RacePage health={health} onFlags={reportRace} />}
        {page === "compare" && <ComparePage runs={runs} onFlags={reportCompare} />}
        {page === "rules" && <RulesPage onFlags={reportRules} />}
      </main>
    </div>
  );
}
