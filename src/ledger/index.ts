/**
 * Usage ledger (owner: P2): append-only JSONL of every REAL external call.
 *
 * Call recordUsage() once per real call to Drex, NDI, Intern, DeepInfra, Keenable or OpenAI.
 * Never call it for mock or cached answers. Never put keys, prompts or response bodies in it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  USAGE_TOOLS,
  UsageEntrySchema,
  UsageSummarySchema,
  type Config,
  type UsageCounts,
  type UsageEntry,
  type UsageSummary,
  type UsageTool,
  type UsageToolSummary,
} from "../contracts";
import { repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

/** Absolute path of the ledger file for a config. */
export function ledgerFile(cfg: Config): string {
  return repoPath(...cfg.ledger.file.split("/"));
}

/** What a caller supplies; the rest is defaulted. */
export type UsageInput = Pick<UsageEntry, "tool" | "purpose"> & Partial<Omit<UsageEntry, "tool" | "purpose" | "ts">>;

/** Append one real external call to the ledger. Returns the entry written. */
export function recordUsage(cfg: Config, input: UsageInput, file: string = ledgerFile(cfg)): UsageEntry {
  const entry = UsageEntrySchema.parse({
    ts: new Date().toISOString(),
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    costUsd: 0,
    counts: {},
    runId: null,
    ...input,
  });
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n");
  return entry;
}

/** Read every ledger entry (empty when the ledger does not exist yet). */
export function readUsage(cfg: Config, file: string = ledgerFile(cfg)): UsageEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => UsageEntrySchema.parse(JSON.parse(line)));
}

const emptyTool = (): UsageToolSummary => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, counts: {}, byPurpose: {} });

/** Total the ledger per tool. Every tool gets an entry, zeroed when unused. */
export function summarizeUsage(entries: readonly UsageEntry[]): UsageSummary {
  const byTool = Object.fromEntries(USAGE_TOOLS.map((tool) => [tool, emptyTool()])) as Record<UsageTool, UsageToolSummary>;
  for (const e of entries) {
    const t = byTool[e.tool];
    t.calls += 1;
    t.inputTokens += e.inputTokens;
    t.outputTokens += e.outputTokens;
    t.costUsd += e.costUsd;
    t.latencyMs += e.latencyMs;
    t.byPurpose[e.purpose] = (t.byPurpose[e.purpose] ?? 0) + 1;
    for (const [key, n] of Object.entries(e.counts) as [keyof UsageCounts, number][]) t.counts[key] = (t.counts[key] ?? 0) + n;
  }
  return UsageSummarySchema.parse({
    generatedTs: new Date().toISOString(),
    totalCalls: entries.length,
    totalCostUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
    byTool,
  });
}

/** The usage_* headline numbers, from a summary. Null when the tool was never called. */
export function usageHeadline(summary: UsageSummary) {
  const count = (tool: UsageTool, key: keyof UsageCounts) => (summary.byTool[tool].calls === 0 ? null : (summary.byTool[tool].counts[key] ?? 0));
  const calls = (tool: UsageTool) => (summary.byTool[tool].calls === 0 ? null : summary.byTool[tool].calls);
  return {
    usage_drex_questions: count("drex", "questions"),
    usage_ndi_docs: count("ndi", "docs"),
    usage_ndi_pages: count("ndi", "pages"),
    usage_intern_sessions: count("intern", "sessions"),
    usage_intern_system1_judgments: count("intern", "system1Judgments"),
    usage_deepinfra_calls: calls("deepinfra"),
    usage_keenable_requests: count("keenable", "requests"),
  };
}

/** Write results/usage.json from the ledger; returns the path. */
export function writeUsageResults(cfg: Config): string {
  const summary = summarizeUsage(readUsage(cfg));
  return writeResults({
    experiment: "usage",
    createdTs: summary.generatedTs,
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { ledger: cfg.ledger },
    rows: USAGE_TOOLS.map((tool) => ({ tool, ...summary.byTool[tool] })),
    summary,
  });
}
