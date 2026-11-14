/**
 * Quirk hunter, legality part: for every playbook entry (accepted lab proposals; quirks later) ask
 * Drex noul questions against every extracted conduct rule, tag LEGAL / RISKY / ILLEGAL, and write
 * results/quirks.json. Uses drexAsk only (usage-ledger wrapped). Run: pnpm quirks
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describeIntent, type Config, type Proposal } from "../contracts";
import { drexAsk, type DrexQuestion } from "../ingest/drexClient";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

export type Legality = "LEGAL" | "RISKY" | "ILLEGAL";
export interface RuleVerdict {
  id: string;
  page: number;
  pViolation: number | null;
}
interface ConductRule {
  id: string;
  topic: string;
  page: number;
  fullText?: string;
  text: string;
  exceptions?: unknown;
  violation?: string;
}

/** Tag from per-rule violation probabilities and the opponent-foul probability. */
export function tagLegality(ps: (number | null)[], reliesOnOpponentFouls: number | null): Legality {
  const v = ps.filter((p): p is number => p !== null);
  if (v.some((p) => p > 0.7)) return "ILLEGAL";
  if (v.some((p) => p >= 0.3) || (reliesOnOpponentFouls !== null && reliesOnOpponentFouls >= 0.3)) return "RISKY";
  return "LEGAL";
}

const ruleText = (r: ConductRule) => {
  const ex = Array.isArray(r.exceptions) && r.exceptions.length > 0 ? ` EXCEPTIONS: ${JSON.stringify(r.exceptions)}` : "";
  return `Rule ${r.id} (manual p.${r.page}): ${(r.fullText ?? r.text).slice(0, 1500)}${ex}`;
};

export async function judgeLegality(cfg: Config, entries: { id: string; description: string }[], rules: ConductRule[]) {
  const errors: Record<string, string> = {};
  const out: Record<string, { rules: RuleVerdict[]; reliesOnOpponentFouls: number | null }> = {};
  for (const e of entries) {
    const questions: Record<string, DrexQuestion> = {};
    for (const r of rules)
      questions[`violates__${r.id}`] = {
        type: "noul",
        instructions: `FRC REBUILT 2026 robot strategy: ${e.description}\n\n${ruleText(r)}\n\nQuestion: would a robot following this strategy as described violate rule ${r.id}?`,
      };
    questions["relies_on_opponent_fouls"] = {
      type: "noul",
      instructions: `FRC REBUILT 2026 robot strategy: ${e.description}\n\nGame rule G210 forbids forcing an opponent to violate a rule. Question: does this strategy's value depend on inducing an opponent to commit a foul?`,
    };
    let res;
    try {
      res = await drexAsk(cfg, { state: { strategy: e.description }, questions, purpose: "quirks_legality", model: "drex-latest" });
    } catch (err) {
      errors[e.id] = (err as Error).message.slice(0, 200);
      out[e.id] = { rules: rules.map((r) => ({ id: r.id, page: r.page, pViolation: null })), reliesOnOpponentFouls: null };
      continue;
    }
    const p = (id: string): number | null => (typeof res.answers[id]?.noul === "number" ? res.answers[id].noul : null);
    out[e.id] = { rules: rules.map((r) => ({ id: r.id, page: r.page, pViolation: p(`violates__${r.id}`) })), reliesOnOpponentFouls: p("relies_on_opponent_fouls") };
  }
  return { out, errors };
}

export async function runQuirks(cfg: Config): Promise<void> {
  const proposals = (JSON.parse(readFileSync(repoPath("data", "lab", "proposals.json"), "utf8")) as { proposals: Proposal[] }).proposals;
  const lab = JSON.parse(readFileSync(repoPath("results", "lab.json"), "utf8")) as { rows: Record<string, any>[] };
  const rules = (JSON.parse(readFileSync(repoPath("data", "rules", "conduct_rules.json"), "utf8")) as { rules: ConductRule[] }).rules;
  const entries = proposals.map((p) => ({ id: p.id, description: `${p.title}. Play: ${describeIntent(p.intent)} Use when: ${p.situation}` }));
  const { out: verdicts, errors } = await judgeLegality(cfg, entries, rules);

  const rows: Record<string, unknown>[] = proposals.map((p) => {
    const v = verdicts[p.id]!;
    const sim = lab.rows.find((r) => r.proposalId === p.id);
    const tested = sim?.simulated === true;
    const err = errors[p.id];
    const legality = err ? null : tagLegality(v.rules.map((r) => r.pViolation), v.reliesOnOpponentFouls);
    return {
      id: p.id,
      title: p.title,
      source: "lab_proposal",
      value: tested
        ? { marginDiff: sim!.marginVsBaseline, ci95: sim!.ci95, n: sim!.nMatches, firesPerMatch: sim!.firesPerMatch }
        : { marginDiff: null, ci95: null, n: null, reason: sim?.reason ?? "not simulated" },
      legality,
      rules: v.rules,
      reliesOnOpponentFouls: v.reliesOnOpponentFouls,
      notes: `Drex noul probabilities of violating each extracted conduct rule (${rules.length} rules, manual pages in rules[].page). ${err ? `NOT JUDGED: Drex call failed (${err}).` : ""}`.trim(),
    };
  });

  // Tower post-up test case: runs only when the engine offers post-up shot spots.
  const postUp = cfg.field.shotSpots.spots.filter((s) => /post.?up/i.test(s.id)).map((s) => s.id);
  rows.push({
    id: "tower_post_up",
    title: "Endgame tower post-up shooting spot vs a normal shot spot",
    source: "tower_post_up",
    value: { marginDiff: null, ci95: null, n: null, reason: postUp.length === 0 ? "not run: engine support pending (no post-up shot spot in config.field.shotSpots)" : "spots present but comparison not yet implemented" },
    legality: null,
    rules: [],
    reliesOnOpponentFouls: null,
    notes: "Intended: paired eval-seed matches, tower post-up vs normal spot in endgame, margin with 95% CI and count of G420 fouls drawn.",
  });
  rows.push({
    id: "intern_rule_scan",
    title: "Intern rule-scan quirk candidates",
    source: "intern_rule_scan",
    value: { marginDiff: null, ci95: null, n: null, reason: "not run: generalisation session not performed" },
    legality: null,
    rules: [],
    reliesOnOpponentFouls: null,
    notes: "",
  });

  const count = (t: Legality) => rows.filter((r) => r.legality === t).length;
  writeResults({
    experiment: "quirks",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { drex: "drex-latest", rules: rules.map((r) => r.id) },
    rows,
    summary: { LEGAL: count("LEGAL"), RISKY: count("RISKY"), ILLEGAL: count("ILLEGAL"), entriesJudged: proposals.length, simulated: rows.filter((r) => (r.value as any).marginDiff !== null).length },
  });
  for (const r of rows) console.log(`[quirks] ${r.id}: ${r.legality ?? "-"}${Array.isArray(r.rules) && r.rules.length ? " " + (r.rules as RuleVerdict[]).map((x) => `${x.id}=${x.pViolation?.toFixed(2)}`).join(" ") : ""} opp-foul=${typeof r.reliesOnOpponentFouls === "number" ? (r.reliesOnOpponentFouls as number).toFixed(2) : "-"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cfg = loadConfig();
  await runQuirks(cfg);
}
