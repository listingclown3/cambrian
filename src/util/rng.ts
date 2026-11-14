/**
 * Seeded random numbers with serializable state (shared utility; isomorphic).
 * Thin wrapper over pure-rand's xoroshiro128+. The state is a plain number[] so it can live
 * inside MatchState and survive JSON round trips.
 */
import { uniformFloat64 } from "pure-rand/distribution/uniformFloat64";
import { uniformInt } from "pure-rand/distribution/uniformInt";
import { xoroshiro128plus, xoroshiro128plusFromState } from "pure-rand/generator/xoroshiro128plus";
import type { RandomGenerator } from "pure-rand/types/RandomGenerator";

/** Bijective 32-bit integer scrambler (murmur3 finalizer). */
function mix32(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

export class Rng {
  private constructor(private readonly gen: RandomGenerator) {}

  /**
   * New generator from an integer seed.
   * xoroshiro128+ gives nearly identical first outputs for neighbouring seeds (1, 2, 3, ...),
   * which would correlate rollouts across seeds. So the seed is scrambled first and the first
   * few outputs are discarded.
   */
  static fromSeed(seed: number): Rng {
    const gen = xoroshiro128plus(mix32(seed));
    for (let i = 0; i < 16; i++) gen.next();
    return new Rng(gen);
  }

  /** Resume a generator from a state produced by getState(). */
  static fromState(state: readonly number[]): Rng {
    return new Rng(xoroshiro128plusFromState(state));
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return uniformFloat64(this.gen);
  }

  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return uniformInt(this.gen, lo, hi);
  }

  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Current state, safe to store in JSON. */
  getState(): number[] {
    return [...this.gen.getState()];
  }
}

/** The generator state for a fresh seed. */
export function seedState(seed: number): number[] {
  return Rng.fromSeed(seed).getState();
}

/** Deterministic 32-bit FNV-1a hash of a string, for deriving sub-seeds from labels. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
