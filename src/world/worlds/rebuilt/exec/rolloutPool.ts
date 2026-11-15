/**
 * Parallel rollouts on a tinypool worker pool (owner: P1).
 *
 *   const pool = new RolloutPool();                       // one worker per core, minus one
 *   const results = await pool.runBatch({ snapshot, overrides, horizonS, seeds, policies: { default: "basic_cycle" } });
 *   await pool.destroy();
 *
 * A batch's seeds are split into chunks, one per worker; results come back in seed order and are
 * identical to running the same batch on the main thread (runRolloutBatch).
 * Works when the parent runs under tsx (pnpm scripts do); workers inherit its loader.
 */
import os from "node:os";
import { fileURLToPath } from "node:url";
import Tinypool from "tinypool";
import { runRolloutBatch, type RolloutBatchTask, type RolloutSummary } from "./rolloutWorker";

export interface RolloutPoolOptions {
  /** Worker threads (default: available cores minus one, at least one). */
  threads?: number;
}

export class RolloutPool {
  private readonly pool: Tinypool;
  readonly threads: number;

  constructor(opts: RolloutPoolOptions = {}) {
    this.threads = Math.max(1, opts.threads ?? (os.availableParallelism?.() ?? os.cpus().length) - 1);
    const workerUrl = new URL("./rolloutWorker.ts", import.meta.url);
    this.pool = new Tinypool({
      filename: fileURLToPath(workerUrl),
      minThreads: this.threads,
      maxThreads: this.threads,
      // The worker file is TypeScript. Workers inherit the parent's execArgv, which under tsx
      // already loads tsx (passing "--import tsx" again crashed the workers on Windows).
    });
  }

  /** Run one batch across the pool. */
  async runBatch(task: RolloutBatchTask): Promise<RolloutSummary[]> {
    if (task.seeds.length === 0) return [];
    const chunk = Math.ceil(task.seeds.length / this.threads);
    const parts: Promise<RolloutSummary[]>[] = [];
    for (let i = 0; i < task.seeds.length; i += chunk) {
      parts.push(this.pool.run({ ...task, seeds: task.seeds.slice(i, i + chunk) }) as Promise<RolloutSummary[]>);
    }
    return (await Promise.all(parts)).flat();
  }

  /** Run many batches at once (for example one per candidate option); results in task order. */
  async runBatches(tasks: RolloutBatchTask[]): Promise<RolloutSummary[][]> {
    return Promise.all(tasks.map((t) => this.runBatch(t)));
  }

  /** Stop the workers. */
  async destroy(): Promise<void> {
    await this.pool.destroy();
  }
}

export { runRolloutBatch };
export type { RolloutBatchTask, RolloutSummary };
