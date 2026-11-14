/**
 * Quirk hunter, legality part: for every playbook entry (accepted lab proposals; quirks later) ask
 * Drex noul questions against every extracted conduct rule, tag LEGAL / RISKY / ILLEGAL, and write
 * results/quirks.json. Uses drexAsk only (usage-ledger wrapped). Run: pnpm quirks
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describeIntent, type Config, type Proposal } from "../contracts";
import { drexAsk as realAsk, type DrexQuestion } from "../ingest/drexClient";
import { loadConfig, repoPath } from "../util/config";
import { acquireShared } from "../decide/providers/sharedLimit";
import { compareTowerPostUp } from "./towerPostUp";
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

/**
 * The real Drex call, paced through the machine-wide shared limiter (src/decide/providers/sharedLimit.ts)
 * and stopped for good after the first 403 (checkpoint block): no retries, no bursts.
 */
let blocked: string | null = null;
export const limitedAsk: Ask = async (cfg, args) => {
  if (blocked) throw new Error(`Drex unreachable: ${blocked}`);
  const lim = cfg.providers.byId.drex.sharedRateLimit;
  const release = lim ? await acquireShared({ dir: repoPath("cache", "ratelimit", "drex"), ...lim }, 60_000, 70_000) : () => {};
  try {
    return await realAsk(cfg, args);
  } catch (e) {
    if (/http 403/.test((e as Error).message)) blocked = (e as Error).message;
    throw e;
  } finally {
    release?.();
  }
};

/** The Drex call, injectable so tests can use a fake judge. */
export type Ask = typeof realAsk;

export async function judgeLegality(cfg: Config, entries: { id: string; description: string }[], rules: ConductRule[], drexAsk: Ask = realAsk) {
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

export async function runQuirks(cfg: Config, ask: Ask = limitedAsk): Promise<void> {
  const proposals = (JSON.parse(readFileSync(repoPath("data", "lab", "proposals.json"), "utf8")) as { proposals: Proposal[] }).proposals;
  const lab = JSON.parse(readFileSync(repoPath("results", "lab.json"), "utf8")) as { rows: Record<string, any>[] };
  const rules = (JSON.parse(readFileSync(repoPath("data", "rules", "conduct_rules.json"), "utf8")) as { rules: ConductRule[] }).rules;
  const entries: { id: string; description: string }[] = proposals.map((p) => ({ id: p.id, description: `${p.title}. Play: ${describeIntent(p.intent)} Use when: ${p.situation}` }));
  let scan: Proposal[] = [];
  try {
    scan = (JSON.parse(readFileSync(repoPath("data", "lab", "rule_scan.json"), "utf8")) as { proposals: Proposal[] }).proposals;
  } catch {
    /* no rule scan was run */
  }
  for (const p of scan) entries.push({ id: p.id, description: `${p.title}. Play: ${describeIntent(p.intent)} Use when: ${p.situation}` });
  entries.push({ id: "tower_post_up", description: "Endgame tower post-up: in the last 30 seconds, with fuel held, drive to a shot spot right next to our own tower (tower_post_left or tower_post_right) and shoot from there instead of a normal shot spot. An opponent that contacts us while it is touching its own tower is called for a major foul under G420." });
  const { out: verdicts, errors } = await judgeLegality(cfg, entries, rules, ask);

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
      notes: `Drex noul probabilities of violating each extracted conduct rule (${rules.length} rules, manual pages in rules[].page). ${err ? `NOT JUDGED: Drex call failed (Drex unreachable: ${err}).` : ""}`.trim(),
    };
  });

  // Tower post-up test case: runs only when the engine offers post-up shot spots.
  const tower = compareTowerPostUp(cfg);
  const tv = verdicts["tower_post_up"]!;
  const terr = errors["tower_post_up"];
  rows.push({
    id: "tower_post_up",
    title: "Endgame tower post-up shooting spot vs a normal shot spot",
    source: "tower_post_up",
    value: tower.run
      ? { marginDiff: tower.marginDiff, ci95: tower.ci95, n: tower.n, firesTotal: tower.fires, g420FoulsOnOpponents: tower.g420FoulsOnOpponents, g420FoulsOnUs: tower.g420FoulsOnUs, spotId: tower.spotId, controlSpotId: tower.controlSpotId }
      : { marginDiff: null, ci95: null, n: null, reason: tower.reason },
    legality: terr ? null : tagLegality(tv.rules.map((r) => r.pViolation), tv.reliesOnOpponentFouls),
    rules: tv.rules,
    reliesOnOpponentFouls: tv.reliesOnOpponentFouls,
    notes: `Paired eval-seed matches in endgame, post-up spot vs normal spot; G420 fouls counted from state.fouls. ${terr ? `Legality NOT JUDGED: Drex unreachable (${terr}).` : ""}`,
  });
  if (scan.length === 0)
    rows.push({ id: "intern_rule_scan", title: "Intern rule-scan quirk candidates", source: "intern_rule_scan", value: { marginDiff: null, ci95: null, n: null, reason: "not run: no rule scan output" }, legality: null, rules: [], reliesOnOpponentFouls: null, notes: "" });
  for (const p of scan) {
    const v = verdicts[p.id]!;
    const err = errors[p.id];
    rows.push({
      id: p.id,
      title: p.title,
      source: "intern_rule_scan",
      value: { marginDiff: null, ci95: null, n: null, reason: "not simulated: no deterministic predicate written for this Intern-proposed situation" },
      legality: err ? null : tagLegality(v.rules.map((r) => r.pViolation), v.reliesOnOpponentFouls),
      rules: v.rules,
      reliesOnOpponentFouls: v.reliesOnOpponentFouls,
      notes: `Situation: ${p.situation} Rationale: ${p.rationale} ${err ? `Legality NOT JUDGED: Drex unreachable (${err}).` : ""}`.trim(),
    });
  }

  const count = (t: Legality) => rows.filter((r) => r.legality === t).length;
  writeResults({
    experiment: "quirks",
    createdTs: new Date().toISOString(),
    isMock: false,
    gitCommit: gitCommit(),
    simHash: simHash(cfg),
    config: { drex: "drex-latest", rules: rules.map((r) => r.id) },
    rows,
    summary: { LEGAL: count("LEGAL"), RISKY: count("RISKY"), ILLEGAL: count("ILLEGAL"), entriesJudged: entries.length, simulated: rows.filter((r) => (r.value as any).marginDiff !== null).length },
  });
  for (const r of rows) console.log(`[quirks] ${r.id}: ${r.legality ?? "-"}${Array.isArray(r.rules) && r.rules.length ? " " + (r.rules as RuleVerdict[]).map((x) => `${x.id}=${x.pViolation?.toFixed(2)}`).join(" ") : ""} opp-foul=${typeof r.reliesOnOpponentFouls === "number" ? (r.reliesOnOpponentFouls as number).toFixed(2) : "-"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cfg = loadConfig();
  // --no-drex: make no Drex call (it is unreachable); legality stays null with the reason
  const offline: Ask = (async () => {
    throw new Error("not called");
  }) as Ask;
  await runQuirks(cfg, process.argv.includes("--no-drex") ? offline : limitedAsk);
}
