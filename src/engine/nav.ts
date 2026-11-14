/**
 * Navigation for the engine (owner: P1): static obstacles, a grid, cached flow fields, steering.
 *
 * Grid pathfinding is adapted from the ideas in Team 488's REBUILT robot simulator
 * (vendor/rebuilt-robotsim/src/simulation/AStar.ts and Field.ts, used with permission): the field
 * is a tile grid, walls and field elements are impassable tiles, and robots route over the grid
 * with a binary-heap shortest-path search. Differences from 488's version:
 *   - the search runs backwards from the goal (Dijkstra, i.e. A* with a zero heuristic), giving a
 *     flow field that answers "which way from here" for every cell at once; it is cached per goal
 *     cell, so robots never re-plan per tick and thousands of rollouts share the same fields;
 *   - obstacles are inflated by the robot radius, so a robot centre on a free cell is a legal pose;
 *   - bump cells cost more (robots slow down on bumps) and trench cells are impassable for robots
 *     that do not fit under the trench.
 *
 * Nothing here lives in MatchState: everything is a pure function of the static field layout and
 * the physics knobs, so caching it outside the state cannot break determinism.
 */
import type { FieldElementSizes, FieldLayout, PhysicsParams, Rect, Vec2 } from "../contracts";

/**
 * Footprints used when the field layout carries none (older snapshots). Same numbers as
 * config/default.json field.elementSizes (TODO_VERIFY_AGAINST_MANUAL there).
 */
const DEFAULT_SIZES: FieldElementSizes = { hubSizeM: 1.19, towerWidthM: 1.25, towerDepthM: 1.14, trenchWidthM: 1.34, bumpWidthM: 1.85 };
/** Grid cell size when physics.navCellM is absent (same as config/default.json). */
const DEFAULT_CELL_M = 0.15;

/** Cell kinds. */
export const FREE = 0;
export const BUMP = 1;
export const TRENCH = 2;
export const BLOCKED = 3;

/** Distance-field cache size per grid; cleared wholesale when full (results are pure, so this is safe). */
const MAX_FIELDS = 600;
/** How many cells ahead along the flow field the steering looks for a straight-line shortcut. */
const LOOKAHEAD_CELLS = 10;

export interface NavGrid {
  cellM: number;
  cols: number;
  rows: number;
  /** Robot radius the obstacles are inflated by. */
  radiusM: number;
  lengthM: number;
  widthM: number;
  /** Kind of each cell (row-major, index = row * cols + col). */
  kind: Uint8Array;
  /** Inflated solid rectangles for every robot. */
  solid: Rect[];
  /** Inflated trench rectangles (solid for robots that do not fit). */
  trenches: Rect[];
  /** Raw (uninflated) bump and trench crossing rectangles, for speed factors. */
  bumpRects: Rect[];
  trenchRects: Rect[];
  /** Cost multiplier per kind. */
  bumpCost: number;
  trenchCost: number;
  /** Cached distance-to-goal fields, keyed by goalCell * 2 + (fits ? 1 : 0). */
  fields: Map<number, Float32Array>;
}

const byObject = new WeakMap<FieldLayout, NavGrid>();
const byKey = new Map<string, NavGrid>();

function inflate(r: Rect, m: number): Rect {
  return { x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m };
}

function inside(r: Rect, x: number, y: number): boolean {
  return x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
}

/** Static obstacle geometry for one field. */
function buildGeometry(field: FieldLayout) {
  const sz = field.elementSizes ?? DEFAULT_SIZES;
  const solidRaw: Rect[] = [];
  const bumpRects: Rect[] = [];
  const trenchRects: Rect[] = [];
  for (const alliance of ["blue", "red"] as const) {
    const a = field.alliances[alliance];
    const hh = sz.hubSizeM / 2;
    solidRaw.push({ x0: a.hub.x - hh, y0: a.hub.y - hh, x1: a.hub.x + hh, y1: a.hub.y + hh });
    solidRaw.push({
      x0: a.tower.x - sz.towerDepthM / 2,
      y0: a.tower.y - sz.towerWidthM / 2,
      x1: a.tower.x + sz.towerDepthM / 2,
      y1: a.tower.y + sz.towerWidthM / 2,
    });
    // The crossing band between this alliance zone and the neutral zone: solid except where a
    // bump, a trench or the hub (its own obstacle) is.
    const lanes = field.lanes.filter((l) => l.side === alliance);
    if (lanes.length === 0) continue;
    const bx0 = Math.min(...lanes.map((l) => Math.min(l.allianceEnd.x, l.neutralEnd.x)));
    const bx1 = Math.max(...lanes.map((l) => Math.max(l.allianceEnd.x, l.neutralEnd.x)));
    const openings: [number, number][] = [[a.hub.y - hh, a.hub.y + hh]];
    for (const l of lanes) {
      const w = (l.route.endsWith("trench") ? sz.trenchWidthM : sz.bumpWidthM) / 2;
      const rect = { x0: bx0, y0: l.allianceEnd.y - w, x1: bx1, y1: l.allianceEnd.y + w };
      (l.route.endsWith("trench") ? trenchRects : bumpRects).push(rect);
      openings.push([rect.y0, rect.y1]);
    }
    openings.sort((p, q) => p[0] - q[0]);
    let y = 0;
    for (const [o0, o1] of openings) {
      if (o0 > y) solidRaw.push({ x0: bx0, y0: y, x1: bx1, y1: o0 });
      y = Math.max(y, o1);
    }
    if (y < field.widthM) solidRaw.push({ x0: bx0, y0: y, x1: bx1, y1: field.widthM });
  }
  return { solidRaw, bumpRects, trenchRects };
}

/** The navigation grid for a field (built once per distinct layout and physics). */
export function getGrid(field: FieldLayout, physics: PhysicsParams): NavGrid {
  const hit = byObject.get(field);
  if (hit && hit.radiusM === physics.robotRadiusM) return hit;
  const key = JSON.stringify([field, physics.robotRadiusM, physics.navCellM, physics.bumpSpeedFactor, physics.trenchSpeedFactor]);
  let grid = byKey.get(key);
  if (!grid) {
    grid = buildGrid(field, physics);
    byKey.set(key, grid);
  }
  byObject.set(field, grid);
  return grid;
}

function buildGrid(field: FieldLayout, physics: PhysicsParams): NavGrid {
  const cellM = physics.navCellM ?? DEFAULT_CELL_M;
  const r = physics.robotRadiusM;
  const cols = Math.ceil(field.lengthM / cellM);
  const rows = Math.ceil(field.widthM / cellM);
  const { solidRaw, bumpRects, trenchRects } = buildGeometry(field);
  const solid = solidRaw.map((s) => inflate(s, r));
  const trenches = trenchRects.map((s) => inflate(s, r));
  const kind = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) * cellM;
    for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cellM;
      let k = FREE;
      if (x < r || y < r || x > field.lengthM - r || y > field.widthM - r) k = BLOCKED;
      else if (solid.some((s) => inside(s, x, y))) k = BLOCKED;
      else if (trenchRects.some((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1)) k = TRENCH;
      else if (trenches.some((s) => inside(s, x, y))) k = TRENCH; // approach to a trench: still too low for tall robots
      else if (bumpRects.some((s) => x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1)) k = BUMP;
      kind[row * cols + col] = k;
    }
  }
  return {
    cellM,
    cols,
    rows,
    radiusM: r,
    lengthM: field.lengthM,
    widthM: field.widthM,
    kind,
    solid,
    trenches,
    bumpRects,
    trenchRects,
    bumpCost: 1 / physics.bumpSpeedFactor,
    trenchCost: 1 / physics.trenchSpeedFactor,
    fields: new Map(),
  };
}

// ── geometry queries ─────────────────────────────────────────────────────────

/** Speed multiplier at a point (bump or trench crossing), 1 elsewhere. */
export function terrainFactor(grid: NavGrid, p: Vec2, physics: PhysicsParams): number {
  for (const s of grid.bumpRects) if (p.x >= s.x0 && p.x <= s.x1 && p.y >= s.y0 && p.y <= s.y1) return physics.bumpSpeedFactor;
  for (const s of grid.trenchRects) if (p.x >= s.x0 && p.x <= s.x1 && p.y >= s.y0 && p.y <= s.y1) return physics.trenchSpeedFactor;
  return 1;
}

/** True when the point lies inside a trench crossing. */
export function inTrench(grid: NavGrid, p: Vec2): boolean {
  for (const s of grid.trenchRects) if (p.x >= s.x0 && p.x <= s.x1 && p.y >= s.y0 && p.y <= s.y1) return true;
  return false;
}

/** True when a robot centre at p overlaps an obstacle (or, for tall robots, a trench). */
export function blockedAt(grid: NavGrid, p: Vec2, fits: boolean): boolean {
  const r = grid.radiusM;
  if (p.x < r - 1e-9 || p.y < r - 1e-9 || p.x > grid.lengthM - r + 1e-9 || p.y > grid.widthM - r + 1e-9) return true;
  for (const s of grid.solid) if (inside(s, p.x, p.y)) return true;
  if (!fits) for (const s of grid.trenches) if (inside(s, p.x, p.y)) return true;
  return false;
}

function pushOut(rects: readonly Rect[], p: Vec2): boolean {
  let moved = false;
  for (const s of rects) {
    if (!inside(s, p.x, p.y)) continue;
    const dl = p.x - s.x0;
    const dr = s.x1 - p.x;
    const db = p.y - s.y0;
    const dt = s.y1 - p.y;
    const m = Math.min(dl, dr, db, dt);
    if (m === dl) p.x = s.x0;
    else if (m === dr) p.x = s.x1;
    else if (m === db) p.y = s.y0;
    else p.y = s.y1;
    moved = true;
  }
  return moved;
}

/**
 * Move p (in place) to the nearest legal robot-centre position: out of obstacles and inside the
 * walls. Used for sliding collisions and to snap targets that sit inside an element.
 */
export function resolvePosition(grid: NavGrid, p: Vec2, fits: boolean): void {
  const r = grid.radiusM;
  for (let i = 0; i < 4; i++) {
    let moved = pushOut(grid.solid, p);
    if (!fits) moved = pushOut(grid.trenches, p) || moved;
    p.x = Math.min(grid.lengthM - r, Math.max(r, p.x));
    p.y = Math.min(grid.widthM - r, Math.max(r, p.y));
    if (!moved) return;
  }
}

/**
 * Move p (in place) to a position that is legal and reachable; returns the result.
 * When a push leaves p stuck in a corner, falls back to the nearest free cell centre.
 */
export function snapTarget(grid: NavGrid, p: Vec2, fits: boolean): Vec2 {
  const q = { x: p.x, y: p.y };
  resolvePosition(grid, q, fits);
  if (!blockedAt(grid, q, fits)) return q;
  const c = nearestFreeCell(grid, cellOf(grid, q), fits);
  return c < 0 ? q : cellCenter(grid, c);
}

/** Segment a->b against the open rectangle s (Liang-Barsky slab test). No closures: this is hot. */
function segHitsRect(ax: number, ay: number, bx: number, by: number, s: Rect): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  // x slabs
  if (Math.abs(dx) < 1e-12) {
    if (ax <= s.x0 || ax >= s.x1) return false;
  } else {
    let ta = (s.x0 - ax) / dx;
    let tb = (s.x1 - ax) / dx;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t1 - t0 <= 1e-9) return false;
  }
  // y slabs
  if (Math.abs(dy) < 1e-12) {
    if (ay <= s.y0 || ay >= s.y1) return false;
  } else {
    let ta = (s.y0 - ay) / dy;
    let tb = (s.y1 - ay) / dy;
    if (ta > tb) {
      const t = ta;
      ta = tb;
      tb = t;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  return t1 - t0 > 1e-9;
}

/** True when a robot can drive in a straight line from a to b without touching an obstacle. */
export function lineOfSight(grid: NavGrid, a: Vec2, b: Vec2, fits: boolean): boolean {
  for (const s of grid.solid) if (segHitsRect(a.x, a.y, b.x, b.y, s)) return false;
  if (!fits) for (const s of grid.trenches) if (segHitsRect(a.x, a.y, b.x, b.y, s)) return false;
  return true;
}

// ── grid and flow fields ─────────────────────────────────────────────────────

export function cellOf(grid: NavGrid, p: Vec2): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(p.x / grid.cellM)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(p.y / grid.cellM)));
  return row * grid.cols + col;
}

export function cellCenter(grid: NavGrid, c: number): Vec2 {
  return { x: ((c % grid.cols) + 0.5) * grid.cellM, y: (Math.floor(c / grid.cols) + 0.5) * grid.cellM };
}

function passable(grid: NavGrid, c: number, fits: boolean): boolean {
  const k = grid.kind[c]!;
  return k === FREE || k === BUMP || (k === TRENCH && fits);
}

function cellCost(grid: NavGrid, c: number): number {
  const k = grid.kind[c]!;
  return k === BUMP ? grid.bumpCost : k === TRENCH ? grid.trenchCost : 1;
}

/** Nearest passable cell by breadth-first search (ties broken by fixed neighbour order). */
export function nearestFreeCell(grid: NavGrid, start: number, fits: boolean): number {
  if (passable(grid, start, fits)) return start;
  const seen = new Uint8Array(grid.kind.length);
  const queue = [start];
  seen[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    if (passable(grid, c, fits)) return c;
    const col = c % grid.cols;
    const row = (c - col) / grid.cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
      const n = nr * grid.cols + nc;
      if (seen[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  return -1;
}

const NEIGHBOURS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

function heapPush(heapCost: number[], heapCell: number[], cost: number, cell: number): void {
  let i = heapCost.length;
  heapCost.push(cost);
  heapCell.push(cell);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapCost[p]! <= cost) break;
    heapCost[i] = heapCost[p]!;
    heapCell[i] = heapCell[p]!;
    i = p;
  }
  heapCost[i] = cost;
  heapCell[i] = cell;
}

function heapPop(heapCost: number[], heapCell: number[]): number {
  const top = heapCell[0]!;
  const lastCost = heapCost.pop()!;
  const lastCell = heapCell.pop()!;
  const len = heapCost.length;
  if (len > 0) {
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= len) break;
      const r = l + 1;
      const m = r < len && heapCost[r]! < heapCost[l]! ? r : l;
      if (heapCost[m]! >= lastCost) break;
      heapCost[i] = heapCost[m]!;
      heapCell[i] = heapCell[m]!;
      i = m;
    }
    heapCost[i] = lastCost;
    heapCell[i] = lastCell;
  }
  return top;
}

/** Distance (in cost-weighted metres) from every cell to the goal cell. Cached. */
export function distanceField(grid: NavGrid, goal: number, fits: boolean): Float32Array {
  const key = goal * 2 + (fits ? 1 : 0);
  const hit = grid.fields.get(key);
  if (hit) return hit;
  if (grid.fields.size >= MAX_FIELDS) grid.fields.clear();

  const n = grid.kind.length;
  const d = new Float32Array(n).fill(Infinity);
  const heapCost: number[] = [];
  const heapCell: number[] = [];
  const push = (cost: number, cell: number): void => heapPush(heapCost, heapCell, cost, cell);
  const pop = (): number => heapPop(heapCost, heapCell);
  const g = passable(grid, goal, fits) ? goal : nearestFreeCell(grid, goal, fits);
  if (g >= 0) {
    d[g] = 0;
    push(0, g);
  }
  const step = grid.cellM;
  const diag = Math.SQRT2 * grid.cellM;
  while (heapCost.length > 0) {
    const costHere = heapCost[0]!;
    const c = pop();
    if (costHere > d[c]!) continue;
    const col = c % grid.cols;
    const row = (c - col) / grid.cols;
    for (let k = 0; k < 8; k++) {
      const [dc, dr] = NEIGHBOURS[k]!;
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
      const nb = nr * grid.cols + nc;
      if (!passable(grid, nb, fits)) continue;
      if (k >= 4 && (!passable(grid, row * grid.cols + nc, fits) || !passable(grid, nr * grid.cols + col, fits))) continue; // no corner cutting
      const nd = Math.fround(costHere + (k >= 4 ? diag : step) * cellCost(grid, nb)); // stored as float32; compare like with like
      if (nd < d[nb]!) {
        d[nb] = nd;
        push(nd, nb);
      }
    }
  }
  grid.fields.set(key, d);
  return d;
}

/** Cheapest neighbour of a cell in a distance field, or -1 at the goal / when stuck. */
function downhill(grid: NavGrid, d: Float32Array, c: number, fits: boolean): number {
  const col = c % grid.cols;
  const row = (c - col) / grid.cols;
  let best = -1;
  let bestD = d[c]!;
  for (let k = 0; k < 8; k++) {
    const [dc, dr] = NEIGHBOURS[k]!;
    const nc = col + dc;
    const nr = row + dr;
    if (nc < 0 || nr < 0 || nc >= grid.cols || nr >= grid.rows) continue;
    const nb = nr * grid.cols + nc;
    if (k >= 4 && (!passable(grid, row * grid.cols + nc, fits) || !passable(grid, nr * grid.cols + col, fits))) continue;
    if (d[nb]! < bestD - 1e-6) {
      bestD = d[nb]!;
      best = nb;
    }
  }
  return best;
}

/** Result of a steering query. */
export interface Steer {
  /** Point to drive straight toward this tick. */
  waypoint: Vec2;
  /** Remaining path length estimate, metres (Infinity when unreachable). */
  remainingM: number;
}

/**
 * Where to drive next to reach `target` from `from`: straight at the target when the way is
 * clear, otherwise toward the farthest visible cell along the cached flow field.
 */
export function steer(grid: NavGrid, from: Vec2, target: Vec2, fits: boolean): Steer {
  const direct = Math.hypot(target.x - from.x, target.y - from.y);
  if (lineOfSight(grid, from, target, fits)) return { waypoint: target, remainingM: direct };
  const d = distanceField(grid, cellOf(grid, target), fits);
  let c = cellOf(grid, from);
  if (!passable(grid, c, fits) || d[c] === Infinity) {
    const f = nearestFreeCell(grid, c, fits);
    if (f < 0 || d[f] === Infinity) return { waypoint: target, remainingM: Infinity };
    c = f;
  }
  let waypoint = cellCenter(grid, c);
  let cur = c;
  for (let i = 0; i < LOOKAHEAD_CELLS; i++) {
    const nb = downhill(grid, d, cur, fits);
    if (nb < 0) break;
    cur = nb;
    const p = cellCenter(grid, cur);
    if (i === 0 || lineOfSight(grid, from, p, fits)) waypoint = p;
    else break;
  }
  const start = cellCenter(grid, c);
  return { waypoint, remainingM: d[c]! + Math.hypot(start.x - from.x, start.y - from.y) };
}
