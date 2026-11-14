/**
 * Run log contract: one JSON object per line (JSONL) in runs/<runId>/events.jsonl.
 *
 * Every line has ts, runId, seq, type and isMock. `seq` increases by 1 per line within a run, so
 * a truncated or reordered log is detectable. The first line is run_start, the last is run_end.
 */
import { z } from "zod";
import { AllianceSchema, RobotIdSchema } from "./common";
import { IntentSchema } from "./actions";
import { DecisionMetaSchema, DecisionRequestSchema } from "./decide";
import { EngineEventSchema } from "./engine";
import { RunManifestSchema } from "./manifest";
import { FoulRecordSchema } from "./state";

const base = {
  /** Wall-clock time the line was written, ISO 8601 UTC. */
  ts: z.string(),
  /** Run this line belongs to. */
  runId: z.string().min(1),
  /** 0-based line number within the run. */
  seq: z.number().int().nonnegative(),
  /** True if this line came from mock or synthetic data. */
  isMock: z.boolean(),
};

export const RunEventSchema = z.discriminatedUnion("type", [
  /** First line of a run. */
  z.object({
    ...base,
    type: z.literal("run_start"),
    /** The run manifest. */
    manifest: RunManifestSchema,
  }),
  /** One decision made for one robot. */
  z.object({
    ...base,
    type: z.literal("decision"),
    /** Robot the decision was for. */
    robotId: RobotIdSchema,
    /** Match time the decision was requested, seconds. */
    matchTimeS: z.number().nonnegative(),
    /** Exactly what the provider was asked. */
    request: DecisionRequestSchema,
    /** Provider bookkeeping (latency, tokens, cost, fallback, cache, error). */
    meta: DecisionMetaSchema,
    /** Label of the option chosen, or null when no option was chosen. */
    chosenLabel: z.string().nullable(),
    /** The intent handed to the engine, or null when the robot was left as it was. */
    intent: IntentSchema.nullable(),
  }),
  /** One engine event, passed through. */
  z.object({
    ...base,
    type: z.literal("engine_event"),
    /** Match the event belongs to (a run may contain many matches). */
    matchId: z.string(),
    /** The engine event. */
    event: EngineEventSchema,
  }),
  /** Scoreboard change. */
  z.object({
    ...base,
    type: z.literal("score"),
    /** Match the score belongs to. */
    matchId: z.string(),
    /** Match time, seconds. */
    matchTimeS: z.number().nonnegative(),
    /** Alliance that scored. */
    alliance: AllianceSchema,
    /** Points added. */
    points: z.number(),
    /** Running totals after the change. */
    totals: z.object({ red: z.number(), blue: z.number() }),
  }),
  /** A foul that was called. */
  z.object({
    ...base,
    type: z.literal("foul"),
    /** Match the foul belongs to. */
    matchId: z.string(),
    /** The foul. */
    foul: FoulRecordSchema,
  }),
  /** One provider's answer to one benchmark scenario. */
  z.object({
    ...base,
    type: z.literal("scenario_result"),
    /** Scenario id. */
    scenarioId: z.string(),
    /** Family the scenario belongs to. */
    familyId: z.string(),
    /** Provider that answered. */
    provider: z.string(),
    /** Model that answered. */
    model: z.string(),
    /** Label the provider chose, or null on failure. */
    chosenLabel: z.string().nullable(),
    /** Best label according to the answer key. */
    bestLabel: z.string(),
    /** True when chosenLabel is the answer-key best (or statistically tied with it). */
    top1: z.boolean(),
    /** Answer-key value of the best option minus the value of the chosen option, points. */
    regret: z.number().nullable(),
    /** Provider bookkeeping for the call. */
    meta: DecisionMetaSchema,
  }),
  /** A batch of rollouts for one candidate option. */
  z.object({
    ...base,
    type: z.literal("rollout_batch"),
    /** Scenario the batch belongs to, or null for live micro-rollouts. */
    scenarioId: z.string().nullable(),
    /** Robot the candidate option was for. */
    robotId: RobotIdSchema,
    /** Label of the candidate option. */
    label: z.string(),
    /** Number of rollouts in the batch. */
    n: z.number().int().positive(),
    /** Rollout horizon, seconds. */
    horizonS: z.number().positive(),
    /** Mean of (pointsFor - pointsAgainst) across the batch. */
    meanMargin: z.number(),
    /** Half-width of the 95% confidence interval of meanMargin. */
    ci95: z.number().nonnegative(),
    /** Wall-clock milliseconds the batch took. */
    wallMs: z.number().nonnegative(),
  }),
  /** Last line of a run. */
  z.object({
    ...base,
    type: z.literal("run_end"),
    /** How the run ended. */
    status: z.enum(["ok", "error", "aborted_spend_cap", "aborted_user"]),
    /** Wall-clock milliseconds the run took. */
    durationMs: z.number().nonnegative(),
    /** Total dollars spent across providers. */
    totalCostUsd: z.number().nonnegative(),
    /** Error message when status is "error"; otherwise null. */
    error: z.string().nullable(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];

/** A run event before the logger stamps ts, runId and seq on it. */
export type RunEventBody = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "ts" | "runId" | "seq"> : never) : never;
