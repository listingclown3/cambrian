/**
 * Usage ledger contract: one line per REAL external call (owner of the implementation: P2,
 * src/ledger). Mock and cached calls are never recorded.
 *
 * The ledger is how the "Built with" panel and the usage_* headline keys are produced, so every
 * module that calls an external tool must record it with recordUsage() from src/ledger.
 */
import { z } from "zod";

/** The external tools we count. */
export const UsageToolSchema = z.enum(["drex", "ndi", "intern", "deepinfra", "keenable", "openai"]);
export type UsageTool = z.infer<typeof UsageToolSchema>;
export const USAGE_TOOLS = UsageToolSchema.options;

/** What one call consumed, in the tool's own units. Omit the ones that do not apply. */
export const UsageCountsSchema = z.strictObject({
  /** drex: questions answered in this call. */
  questions: z.number().int().nonnegative().optional(),
  /** ndi: documents processed. */
  docs: z.number().int().nonnegative().optional(),
  /** ndi: pages processed. */
  pages: z.number().int().nonnegative().optional(),
  /** intern: sessions (1 per run). */
  sessions: z.number().int().nonnegative().optional(),
  /** intern: System 1 (Drex) supervisor judgments in the session. */
  system1Judgments: z.number().int().nonnegative().optional(),
  /** intern: agent turns in the session. */
  turns: z.number().int().nonnegative().optional(),
  /** keenable: search or fetch requests. */
  requests: z.number().int().nonnegative().optional(),
});
export type UsageCounts = z.infer<typeof UsageCountsSchema>;

/** One real external call. One JSON object per line in the ledger file. */
export const UsageEntrySchema = z.object({
  /** When the call finished, ISO 8601 UTC. */
  ts: z.string(),
  /** Which tool was called. */
  tool: UsageToolSchema,
  /** What the call was for, as a short stable slug (for example "play_call", "rules_extract"). */
  purpose: z.string().min(1),
  /** Model id the tool reported, when it has one. */
  model: z.string().nullable(),
  /** Input tokens billed (0 when the tool does not report tokens). */
  inputTokens: z.number().int().nonnegative(),
  /** Output tokens billed (0 when the tool does not report tokens). */
  outputTokens: z.number().int().nonnegative(),
  /** Wall-clock milliseconds the call took. */
  latencyMs: z.number().nonnegative(),
  /** Cost in US dollars (0 when unknown). */
  costUsd: z.number().nonnegative(),
  /** Tool-specific counts. */
  counts: UsageCountsSchema,
  /** Run the call belonged to, or null. */
  runId: z.string().nullable(),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

/** Totals for one tool. */
export const UsageToolSummarySchema = z.object({
  /** Number of ledger entries (calls). */
  calls: z.number().int().nonnegative(),
  /** Sum of input tokens. */
  inputTokens: z.number().int().nonnegative(),
  /** Sum of output tokens. */
  outputTokens: z.number().int().nonnegative(),
  /** Sum of cost, US dollars. */
  costUsd: z.number().nonnegative(),
  /** Sum of latency, milliseconds. */
  latencyMs: z.number().nonnegative(),
  /** Sum of each tool-specific count. */
  counts: UsageCountsSchema,
  /** Number of calls per purpose. */
  byPurpose: z.record(z.string(), z.number().int().nonnegative()),
});
export type UsageToolSummary = z.infer<typeof UsageToolSummarySchema>;

/** Totals for every tool; served by GET /api/usage and written to results/usage.json. */
export const UsageSummarySchema = z.object({
  /** When the summary was computed, ISO 8601 UTC. */
  generatedTs: z.string(),
  /** Total ledger entries. */
  totalCalls: z.number().int().nonnegative(),
  /** Total cost across tools, US dollars. */
  totalCostUsd: z.number().nonnegative(),
  /** Per-tool totals. Every tool has an entry, zeroed when unused. */
  byTool: z.record(UsageToolSchema, UsageToolSummarySchema),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
