/**
 * Strategy Lab contract (owner of the implementation: P3, src/search/proposals).
 *
 * System 2 (a large model on DeepInfra, running inside Intern and supervised by Drex) reads the
 * research and proposes strategies; the simulator then tests each one. Proposals arrive as
 * untrusted JSON written by an agent, so they are validated with these schemas and rejected when
 * invalid. Nothing from Intern's workspace is trusted beyond this file's shapes.
 */
import { z } from "zod";
import { CaptainRoleSchema, IntentSchema } from "./actions";

/** Most proposals accepted from one lab run. */
export const MAX_LAB_PROPOSALS = 5;

/** One strategy proposed by the lab. */
export const ProposalSchema = z.object({
  /** Short stable id, unique within the file (for example "stage_before_shift"). */
  id: z.string().regex(/^[a-z0-9_]{3,40}$/),
  /** Human-readable name. */
  title: z.string().min(1).max(80),
  /**
   * strategy_family - a new kind of sticky situation plus the play to make in it
   * option_variant  - a new two-step option (an Intent with `then`) for an existing situation
   */
  kind: z.enum(["strategy_family", "option_variant"]),
  /** One sentence on why this should work. */
  rationale: z.string().min(1).max(300),
  /** The research page(s) the idea came from. At least one. */
  sourceUrls: z.array(z.string().url()).min(1),
  /** When to use it, in plain words (for example "our hub goes inactive in under 5 s and we hold fuel"). */
  situation: z.string().min(1).max(300),
  /** The play itself. Must satisfy the Intent contract, including ALLOWED_PAIRS for `then`. */
  intent: IntentSchema,
  /** Captain role the play suits, when it is role-specific. */
  role: CaptainRoleSchema.optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** The file Intern writes (lab/workspace/proposals.json) and we copy to data/lab/proposals.json. */
export const ProposalsFileSchema = z.object({
  /** The proposals, at most MAX_LAB_PROPOSALS. */
  proposals: z.array(ProposalSchema).max(MAX_LAB_PROPOSALS),
});
export type ProposalsFile = z.infer<typeof ProposalsFileSchema>;

/** How one proposal did in simulation; one row of results/lab.json. */
export const LabResultRowSchema = z.object({
  /** Proposal id. */
  proposalId: z.string(),
  /** Mean match margin with the proposal minus mean margin of the scripted baseline, eval seeds. */
  marginVsBaseline: z.number(),
  /** Half-width of the 95% confidence interval of marginVsBaseline. */
  ci95: z.number().nonnegative(),
  /** Number of eval-seed matches played. */
  nMatches: z.number().int().nonnegative(),
  /** Mean answer-key value of the proposal on the scenario families it applies to, or null. */
  scenarioValue: z.number().nullable(),
  /** True when marginVsBaseline - ci95 > 0. */
  beatsBaseline: z.boolean(),
});
export type LabResultRow = z.infer<typeof LabResultRowSchema>;
