/** Shared helpers for the web client (owner: P4). */
import { useEffect, useState } from "react";
import type { Headline, UsageSummary, Config, Scenario, ScenarioFamily } from "../../src/contracts";
import type { RunListing } from "../../src/server/protocol";

/** Fetch JSON once; error and loading are explicit so pages never fake data. */
export function useApi<T>(url: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    setData(null);
    setError(null);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((d: T) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [url]);
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
