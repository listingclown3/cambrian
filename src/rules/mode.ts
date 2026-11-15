/**
 * Rules mode (notes/decisions.md, "Rules mode defaults" and F2).
 *
 *   off      only physics counts: every quirk is kept, legality is ignored
 *   flag     rule breaks are labelled and kept, and go to triage
 *   enforce  rule breaks are discarded
 *
 * Legality itself comes from the existing Drex rule checks (src/search/proposals/quirks.ts, which
 * tags LEGAL / RISKY / ILLEGAL from per-rule violation probabilities, and src/history/ingest/
 * ruleJudge.ts). This module only decides what a mode does with that label.
 */
import type { Legality, RulesMode, WorldTier } from "../contracts";

/** Tier 1 worlds (the sim is the game) default to off; Tier 2 worlds (models of reality) to flag. */
export function defaultRulesMode(tier: WorldTier): RulesMode {
  return tier === "game" ? "off" : "flag";
}

export type RuleDecision = "keep" | "keep_flagged" | "discard";

/**
 * What a mode does with a judged quirk. In `enforce`, only ILLEGAL is discarded: RISKY means the
 * judge is unsure, so it is kept and flagged for a person to decide.
 */
export function applyRulesMode(mode: RulesMode, legality: Legality): RuleDecision {
  if (mode === "off") return "keep";
  if (legality === "LEGAL") return "keep";
  if (mode === "enforce" && legality === "ILLEGAL") return "discard";
  return "keep_flagged";
}

/**
 * F2: may the steering model mask actions for being illegal? Only in `enforce`. In other modes it
 * may still mask pointless actions (no state change, repeat loops), never illegal-looking ones,
 * because those are where quirks live.
 */
export function mayMaskIllegal(mode: RulesMode): boolean {
  return mode === "enforce";
}
