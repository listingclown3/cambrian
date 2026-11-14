/**
 * Where a latency measurement was taken (owner: P2): machine, CPU, load and a network note, so
 * latency numbers in results files can be judged in context. Never includes secrets or the IP.
 */
import os from "node:os";

export interface RunEnvironment {
  machine: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  /** 1/5/15-minute load averages (always [0, 0, 0] on Windows; see freeMemMb instead). */
  loadAvg: number[];
  freeMemMb: number;
  totalMemMb: number;
  node: string;
  /** One-line description of the network, from --network "<text>" (null when not given). */
  network: string | null;
  measuredTs: string;
}

export function runEnvironment(argv: readonly string[] = process.argv): RunEnvironment {
  const i = argv.indexOf("--network");
  return {
    machine: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg().map((x) => Math.round(x * 100) / 100),
    freeMemMb: Math.round(os.freemem() / 2 ** 20),
    totalMemMb: Math.round(os.totalmem() / 2 ** 20),
    node: process.version,
    network: i >= 0 && argv[i + 1] ? argv[i + 1]!.slice(0, 200) : null,
    measuredTs: new Date().toISOString(),
  };
}
