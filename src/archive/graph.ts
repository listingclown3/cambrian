/**
 * Quirk archive as a graph (notes/decisions.md, A and B).
 *
 *   node  = one quirk: start conditions, end state, effect, legality, reproducibility, value
 *   edge  = A -> B when A's end state satisfies B's start conditions (or a person linked them)
 *   chain = any simple path through the graph: any start, any length, links may be skipped
 *           (A -> C is its own edge when A's end state already satisfies C)
 *
 * Chain shape is not forced: `chains` enumerates paths, `reachable` returns the whole subgraph
 * from a set of starts for callers that compose non-linear strategies themselves.
 *
 * Credit-back: quirks that appear in winning chains gain value even when they are useless alone
 * (stepping stones), so the next round of search can prefer states near them.
 */
import { ArchiveFileSchema, QuirkNodeSchema, type ArchiveFile, type Condition, type QuirkEdge, type QuirkNode, type StateRecord } from "../contracts";

/** True when every condition holds in `state`. A missing key fails its condition. */
export function satisfies(state: StateRecord, conditions: readonly Condition[]): boolean {
  return conditions.every((c) => {
    if (!(c.key in state)) return false;
    const v = state[c.key]!;
    switch (c.op) {
      case "eq":
        return v === c.value;
      case "ne":
        return v !== c.value;
      case "in":
        return Array.isArray(c.value) && (c.value as (string | number)[]).includes(v as string | number);
      default: {
        if (typeof v !== "number" || typeof c.value !== "number") return false;
        if (c.op === "lt") return v < c.value;
        if (c.op === "lte") return v <= c.value;
        if (c.op === "gt") return v > c.value;
        return v >= c.value;
      }
    }
  });
}

export interface ChainOptions {
  /** Start only from these node ids (default: every node). */
  from?: readonly string[];
  /** Maximum nodes in a chain (default 8). Raise it for deep chains; the cap below still bounds the work. */
  maxDepth?: number;
  /** Stop after this many chains (default 1000). */
  maxChains?: number;
  /** Shortest chain to report, in nodes (default 2: a single quirk is not a chain). */
  minLength?: number;
}

export class QuirkArchive {
  readonly world: string;
  private readonly nodes = new Map<string, QuirkNode>();
  private readonly out = new Map<string, Map<string, QuirkEdge>>();

  constructor(world: string, nodes: readonly QuirkNode[] = [], edges: readonly QuirkEdge[] = []) {
    this.world = world;
    for (const n of nodes) this.add(n);
    for (const e of edges) if (e.how === "manual") this.link(e.from, e.to, { force: true });
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): QuirkNode | undefined {
    return this.nodes.get(id);
  }

  all(): QuirkNode[] {
    return [...this.nodes.values()];
  }

  edges(): QuirkEdge[] {
    return [...this.out.values()].flatMap((m) => [...m.values()]);
  }

  next(id: string): string[] {
    return [...(this.out.get(id)?.keys() ?? [])];
  }

  /**
   * Add a quirk and link it to every existing quirk whose conditions match, in both directions.
   * A node with no start conditions receives no automatic incoming links (it would match every
   * state); it can still start chains and be linked by hand.
   */
  add(node: QuirkNode): void {
    const n = QuirkNodeSchema.parse(node);
    if (n.world !== this.world) throw new Error(`quirk ${n.id} is from world ${n.world}, archive is ${this.world}`);
    if (this.nodes.has(n.id)) throw new Error(`quirk ${n.id} is already archived`);
    this.nodes.set(n.id, n);
    this.out.set(n.id, new Map());
    for (const m of this.nodes.values()) {
      if (m.id === n.id) continue;
      if (n.start.length > 0 && satisfies(m.end, n.start)) this.edge(m.id, n.id, "conditions");
      if (m.start.length > 0 && satisfies(n.end, m.start)) this.edge(n.id, m.id, "conditions");
    }
  }

  /** Link two quirks by hand. Without `force` the link must also satisfy the conditions. */
  link(from: string, to: string, opts: { force?: boolean } = {}): void {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b) throw new Error(`cannot link unknown quirk ${!a ? from : to}`);
    if (from === to) throw new Error("a quirk cannot link to itself");
    if (!opts.force && !(b.start.length > 0 && satisfies(a.end, b.start))) throw new Error(`${from} end state does not satisfy ${to} start conditions`);
    this.edge(from, to, opts.force && !(b.start.length > 0 && satisfies(a.end, b.start)) ? "manual" : "conditions");
  }

  private edge(from: string, to: string, how: QuirkEdge["how"]): void {
    this.out.get(from)!.set(to, { from, to, how });
  }

  /** Every simple path (no node twice) up to the limits, in depth-first order. */
  chains(opts: ChainOptions = {}): string[][] {
    const maxDepth = opts.maxDepth ?? 8;
    const maxChains = opts.maxChains ?? 1000;
    const minLength = opts.minLength ?? 2;
    const result: string[][] = [];
    const starts = opts.from ?? [...this.nodes.keys()];
    for (const s of starts) {
      if (!this.nodes.has(s)) throw new Error(`unknown start quirk ${s}`);
      // iterative DFS so very deep chains do not overflow the call stack
      const stack: { path: string[]; seen: Set<string> }[] = [{ path: [s], seen: new Set([s]) }];
      while (stack.length > 0) {
        const { path, seen } = stack.pop()!;
        if (path.length >= minLength) {
          result.push(path);
          if (result.length >= maxChains) return result;
        }
        if (path.length >= maxDepth) continue;
        const nexts = this.next(path[path.length - 1]!).filter((n) => !seen.has(n)).reverse();
        for (const n of nexts) stack.push({ path: [...path, n], seen: new Set(seen).add(n) });
      }
    }
    return result;
  }

  /** Ids reachable from `from` (inclusive), for callers that build non-linear strategies. */
  reachable(from: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id) || !this.nodes.has(id)) continue;
      seen.add(id);
      queue.push(...this.next(id));
    }
    return seen;
  }

  /**
   * Credit-back: spread `reward` (the chain's measured gain on the goal metric) over the chain's
   * quirks. Each gains rate * reward / chain length, whatever its effect alone, so stepping stones
   * that only pay off in combination rise in value.
   */
  creditBack(chain: readonly string[], reward: number, rate = 0.1): void {
    if (chain.length === 0) return;
    const share = (rate * reward) / chain.length;
    for (const id of chain) {
      const n = this.nodes.get(id);
      if (!n) throw new Error(`unknown quirk ${id} in chain`);
      this.nodes.set(id, { ...n, value: n.value + share });
    }
  }

  toJSON(): ArchiveFile {
    return { version: 1, world: this.world, createdTs: new Date().toISOString(), nodes: this.all(), edges: this.edges() };
  }

  static fromJSON(file: unknown): QuirkArchive {
    const f = ArchiveFileSchema.parse(file);
    return new QuirkArchive(f.world, f.nodes, f.edges);
  }
}
