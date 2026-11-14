import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { USAGE_TOOLS } from "../contracts";
import { loadConfig } from "../util/config";
import { readUsage, recordUsage, summarizeUsage, usageHeadline } from "./index";

const cfg = loadConfig();
const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
const file = path.join(dir, "usage.jsonl");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("usage ledger", () => {
  it("starts empty, with every tool zeroed and every headline number null", () => {
    const summary = summarizeUsage(readUsage(cfg, file));
    expect(Object.keys(summary.byTool).sort()).toEqual([...USAGE_TOOLS].sort());
    expect(summary.totalCalls).toBe(0);
    expect(Object.values(usageHeadline(summary)).every((v) => v === null)).toBe(true);
  });

  it("appends entries and totals them per tool", () => {
    recordUsage(cfg, { tool: "drex", purpose: "play_call", model: "drex-v2.0", inputTokens: 900, latencyMs: 40, costUsd: 0.0001, counts: { questions: 3 } }, file);
    recordUsage(cfg, { tool: "drex", purpose: "rule_judge", inputTokens: 100, latencyMs: 30, counts: { questions: 1 } }, file);
    recordUsage(cfg, { tool: "ndi", purpose: "rules_extract", counts: { docs: 1, pages: 12 } }, file);
    recordUsage(cfg, { tool: "intern", purpose: "strategy_lab", counts: { sessions: 1, system1Judgments: 7, turns: 9 } }, file);
    recordUsage(cfg, { tool: "deepinfra", purpose: "play_call", inputTokens: 1200, outputTokens: 30 }, file);
    recordUsage(cfg, { tool: "keenable", purpose: "search", counts: { requests: 1 } }, file);

    const entries = readUsage(cfg, file);
    expect(entries).toHaveLength(6);
    const summary = summarizeUsage(entries);
    expect(summary.byTool.drex).toMatchObject({ calls: 2, inputTokens: 1000, counts: { questions: 4 }, byPurpose: { play_call: 1, rule_judge: 1 } });
    expect(usageHeadline(summary)).toEqual({
      usage_drex_questions: 4,
      usage_ndi_docs: 1,
      usage_ndi_pages: 12,
      usage_intern_sessions: 1,
      usage_intern_system1_judgments: 7,
      usage_deepinfra_calls: 1,
      usage_keenable_requests: 1,
    });
  });

  it("rejects an unknown tool", () => {
    expect(() => recordUsage(cfg, { tool: "claude" as never, purpose: "x" }, file)).toThrow();
  });
});
