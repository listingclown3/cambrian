/**
 * World adapter: what the search needs from any world, built for you or brought by the user.
 *
 * A world exposes seeded episodes, the metrics a goal can be written against, and a version hash
 * (results are comparable only when it matches). Tier and default rules mode come from
 * notes/decisions.md (C and "Rules mode defaults").
 */
import type { GoalMetric, RulesMode, StateRecord, WorldTier } from "../contracts";

export interface EpisodeOutcome {
  seed: number;
  /** Metric id -> value, for every metric in WorldAdapter.metrics. */
  metrics: Record<string, number>;
  /** Flat end state for the archive (only keys the world chooses to expose). */
  end: StateRecord;
}

export interface WorldAdapter<Policy> {
  id: string;
  title: string;
  tier: WorldTier;
  defaultRulesMode: RulesMode;
  /** Metrics a goal may use. */
  metrics: readonly GoalMetric[];
  /** Hash of everything that determines world behaviour. */
  versionHash(): string;
  /** Play one seeded episode to the end. Same seed and policy -> same outcome. */
  runEpisode(seed: number, policy: Policy): EpisodeOutcome;
}

/**
 * Builds a world from a plain-words description plus researched sources (the "built for you"
 * path). Intended implementation: the most capable model available writes the world code once,
 * checked against the sources. TODO: not implemented; worlds are brought by hand today.
 */
export interface WorldBuilder<Policy> {
  build(description: string, sources: readonly { url: string; content: string }[]): Promise<WorldAdapter<Policy>>;
}
