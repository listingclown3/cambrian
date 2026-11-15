/**
 * Machine-wide request pacing (owner: P2): one limiter shared by EVERY process on this computer
 * that calls a provider, so a dozen agents together stay under a polite rate.
 *
 * Config: providers.byId.<id>.sharedRateLimit = { requestsPerSecond, maxInFlight }.
 * State lives in cache/ratelimit/<id>/state.json, guarded by a mkdir lock (atomic on every OS):
 *   nextStartMs - earliest time the next request may start (requests are spaced 1000/rps ms apart)
 *   inFlight    - requests started and not yet released, each with an expiry so a crashed
 *                 process cannot hold a slot for ever
 * acquire() waits (polling) until a slot and a start time are free, up to maxWaitMs, then gives
 * up with an error that says the request was never sent.
 */
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SharedLimitOptions {
  dir: string;
  requestsPerSecond: number;
  maxInFlight: number;
}

interface State {
  nextStartMs: number;
  inFlight: { id: string; untilMs: number }[];
}

const STALE_LOCK_MS = 5_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withLock<T>(dir: string, fn: () => T): T | undefined {
  const lock = path.join(dir, "lock");
  try {
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock); // holder died
    } catch {
      /* raced with the holder releasing it */
    }
    return undefined;
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function readState(file: string): State {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as State;
    if (typeof s.nextStartMs === "number" && Array.isArray(s.inFlight)) return s;
  } catch {
    /* missing or torn: start fresh */
  }
  return { nextStartMs: 0, inFlight: [] };
}

let counter = 0;

/**
 * Wait for a slot. Resolves to a release function, or to null when no slot came free within
 * maxWaitMs (the caller must then not send the request). `holdMs` bounds how long the slot is
 * held if the process dies before releasing it.
 */
export async function acquireShared(opts: SharedLimitOptions, maxWaitMs: number, holdMs: number): Promise<(() => void) | null> {
  mkdirSync(opts.dir, { recursive: true });
  const file = path.join(opts.dir, "state.json");
  const id = `${process.pid}-${++counter}`;
  const spacing = 1000 / opts.requestsPerSecond;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    let waitMs = 2;
    const got = withLock(opts.dir, () => {
      const now = Date.now();
      const s = readState(file);
      s.inFlight = s.inFlight.filter((f) => f.untilMs > now);
      if (s.inFlight.length < opts.maxInFlight && now >= s.nextStartMs) {
        s.inFlight.push({ id, untilMs: now + holdMs });
        s.nextStartMs = Math.max(now, s.nextStartMs) + spacing;
        writeFileSync(file, JSON.stringify(s));
        return true;
      }
      waitMs = s.inFlight.length >= opts.maxInFlight ? 10 : Math.max(1, s.nextStartMs - now);
      writeFileSync(file, JSON.stringify(s));
      return false;
    });
    if (got) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        void releaseLater(opts.dir, file, id);
      };
    }
    if (Date.now() + Math.min(waitMs, 50) > deadline) return null;
    await sleep(Math.min(waitMs, 50));
  }
}

async function releaseLater(dir: string, file: string, id: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const done = withLock(dir, () => {
      const s = readState(file);
      s.inFlight = s.inFlight.filter((f) => f.id !== id);
      writeFileSync(file, JSON.stringify(s));
      return true;
    });
    if (done) return;
    await sleep(2);
  }
  // Could not get the lock for a second: the slot expires on its own (holdMs).
}
