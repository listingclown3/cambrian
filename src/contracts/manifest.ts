/**
 * Run manifest contract: everything needed to say exactly what a run was and to reproduce it.
 * Written as the payload of the first event (run_start) of every run log.
 */
import { z } from "zod";
import { ConfigSchema } from "./config";

export const RunManifestSchema = z.object({
  /** Unique run id; also the folder name under runs/. */
  runId: z.string().min(1),
  /** Git commit of the repo at run time ("uncommitted" when the tree is dirty or not a repo). */
  gitCommit: z.string(),
  /** Hash of the engine source (src/engine, src/exec, src/contracts) plus the config. */
  simHash: z.string(),
  /** The full config the run used. */
  config: ConfigSchema,
  /** Seeds the run used. Dev and eval sets are kept separate; a reported result uses eval only. */
  seeds: z.object({
    /** Dev seeds used (tuning runs). */
    dev: z.array(z.number().int()),
    /** Eval seeds used (reported runs). */
    eval: z.array(z.number().int()),
  }),
  /** Decision provider under test ("mixed" for runs that compare several). */
  provider: z.string(),
  /** Model id used by that provider. */
  model: z.string(),
  /** True if any part of the run used mock or synthetic answers. */
  isMock: z.boolean(),
  /** Run start time, ISO 8601 UTC. */
  startedTs: z.string(),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;
