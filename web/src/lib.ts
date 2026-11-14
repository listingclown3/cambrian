/** Shared helpers for the web client (owner: P4). */
import { useEffect, useState } from "react";
import type { Headline, UsageSummary, Config, Scenario, ScenarioFamily } from "../../src/contracts";
import type { RunListing } from "../../src/server/protocol";

/** Fetch JSON once; error and loading are explicit so pages never fake data. */
export function useApi<T>(url: string | null, refreshMs?: number): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    setData(null);
    setError(null);
    const load = () =>
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
        .then((d: T) => {
          if (live) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    const id = refreshMs ? setInterval(load, refreshMs) : 0;
    return () => {
      live = false;
      if (id) clearInterval(id);
    };
  }, [url, refreshMs]);
  return { data, error };
}

export interface Health {
  ok: boolean;
  engineIsStub: boolean;
  gitCommit: string;
  simHash: string;
  unverifiedConstants: number;
}
export interface ProviderRow {
  id: string;
  model: string;
  implemented: boolean;
  keyPresent: boolean;
}
export interface ScenarioPick {
  label: string;
  probabilities?: Record<string, number>;
}
export interface ScenarioPayload {
  source: "fixture" | "results" | "none";
  isMock?: boolean;
  note?: string;
  families: ScenarioFamily[];
  scenarios: Scenario[];
  picks: Record<string, Record<string, ScenarioPick | null>>;
}
export type { Headline, UsageSummary, Config, RunListing };

export interface ResultView {
  isMock?: boolean;
  config?: Record<string, unknown>;
  summary?: Record<string, unknown>;
}
/** One results file by name (results/<name>.json); data is null while loading or when the file does not exist. */
export function useResult(name: string, refreshMs?: number): ResultView | null {
  return useApi<ResultView>(`/api/results/${name}`, refreshMs).data;
}

/** "Qwen/Qwen3.5-397B-A17B · reasoning off" style label for the giant; null while unknown. */
export function giantLabel(model: string | null | undefined, reasoning = "off"): string {
  return `${model ?? "giant model not resolved yet"} · reasoning ${reasoning}`;
}

export const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : `${Math.round(v)} ms`);
export const usd = (v: number): string => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
export const signed = (v: number, d = 1): string => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(d)}`;
export const pct = (frac: number): string => `${(frac * 100).toFixed(0)}%`;
export const NOT_RUN = "not run yet";

/** "R2" -> "Red 2", "B1" -> "Blue 1"; anything else is returned unchanged. */
export function robotName(id: string): string {
  const m = /^([RB])(\d+)$/.exec(id);
  return m ? `${m[1] === "R" ? "Red" : "Blue"} ${m[2]}` : id;
}
