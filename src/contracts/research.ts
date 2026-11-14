/**
 * Research and ingest contracts (owner of producers: P5, src/research and src/ingest).
 *
 *   Keenable -> RawPage files in data/research/raw/
 *   NDI      -> Rule[] in data/rules/rules.json            (manual + Team Update, page citations)
 *            -> ResearchNote[] in data/research/notes.json (strategy claims, URL citations)
 *            -> SourcedProfile[] in data/league/teams_from_docs.json and from scouting sheets
 */
import { z } from "zod";
import { ArchetypeSchema, RobotProfileSchema } from "./profiles";

/** Which parser produced a value. "fallback" = our own parser, used only when NDI failed. */
export const ParserSchema = z.enum(["ndi", "fallback"]);
export type Parser = z.infer<typeof ParserSchema>;

/** One web page saved by Keenable research. */
export const RawPageSchema = z.object({
  /** Page URL. */
  url: z.string().url(),
  /** When it was fetched, ISO 8601 UTC. */
  fetchedTs: z.string(),
  /** The search query that found it. */
  query: z.string(),
  /** Page title, when known. */
  title: z.string().nullable(),
  /** Page content as markdown. */
  content: z.string(),
});
export type RawPage = z.infer<typeof RawPageSchema>;

/** One strategy claim taken from a source, with a short supporting quote. */
export const ResearchNoteSchema = z.object({
  /** The claim, in our own words. */
  claim: z.string().min(1),
  /** URL of the page the claim came from. */
  sourceUrl: z.string().url(),
  /** Supporting quote from the page, at most 25 words. */
  quote: z.string().refine((q) => q.trim().split(/\s+/).length <= 25, "quote must be at most 25 words"),
});
export type ResearchNote = z.infer<typeof ResearchNoteSchema>;

/** One rule extracted from the game manual or a Team Update. */
export const RuleSchema = z.object({
  /** Stable id (the manual's clause id when it has one, for example a G-rule number). */
  id: z.string().min(1),
  /** The rule in plain words. */
  text: z.string().min(1),
  /** Where it came from. */
  citation: z.object({
    /** Document name (for example "2026 Game Manual" or "Team Update 05"). */
    document: z.string(),
    /** Page number in that document. */
    page: z.number().int().positive(),
    /** Short supporting quote, at most 25 words. */
    quote: z.string().nullable(),
  }),
  /**
   * The config constant this rule settles, as a dotted path (for example "game.endgameS"), with
   * the value the manual gives. A verified rule overrides a TODO_VERIFY_AGAINST_MANUAL value.
   */
  config: z
    .object({
      /** Dotted path into config (game.* or field.*). */
      path: z.string(),
      /** The value according to the manual. */
      value: z.unknown(),
    })
    .nullable(),
  /** Which parser produced it. */
  parser: ParserSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

/** Where one profile field's value came from. */
export const FieldProvenanceSchema = z.object({
  /** URL or scouting-sheet id the value was read from. */
  source: z.string(),
  /** Supporting quote, at most 25 words, when there is one. */
  quote: z.string().nullable(),
  /** Which parser produced it. */
  parser: ParserSchema,
});
export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;

/**
 * A robot profile built from documents. Fields the documents did not state are filled from the
 * archetype template and have no provenance entry, so "known" and "assumed" stay separable.
 */
export const SourcedProfileSchema = z.object({
  /** The complete profile. */
  profile: RobotProfileSchema,
  /** Provenance per profile field that was actually read from a document. */
  provenance: z.record(z.string(), FieldProvenanceSchema),
  /** Archetype chosen by Drex, with its confidence, when classification has run. */
  classifiedArchetype: z.object({ archetype: ArchetypeSchema, confidence: z.number().min(0).max(1) }).nullable(),
});
export type SourcedProfile = z.infer<typeof SourcedProfileSchema>;
