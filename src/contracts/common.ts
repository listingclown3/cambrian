/**
 * Shared primitives used by every other contract.
 *
 * RULE FOR THE WHOLE `src/contracts/` FOLDER: isomorphic code only (no `node:` imports, no fs).
 * The web client imports these files directly.
 */
import { z } from "zod";

/** Alliance colour. Blue's alliance wall is at x = 0, red's is at x = field.lengthM. */
export const AllianceSchema = z.enum(["red", "blue"]);
export type Alliance = z.infer<typeof AllianceSchema>;
export const ALLIANCES = AllianceSchema.options;

/** The opposing alliance. */
export function otherAlliance(a: Alliance): Alliance {
  return a === "red" ? "blue" : "red";
}

/** Stable robot identifier, unique within a match (for example "R1", "B3"). */
export const RobotIdSchema = z.string().min(1);
export type RobotId = z.infer<typeof RobotIdSchema>;

/** A point or vector on the field, in metres. x runs along the field length, y across its width. */
export const Vec2Schema = z.object({
  /** Metres along the field length; 0 = blue alliance wall. */
  x: z.number(),
  /** Metres across the field width; 0 = the scoring-table side wall. */
  y: z.number(),
});
export type Vec2 = z.infer<typeof Vec2Schema>;

/** Robot pose on the field. */
export const PoseSchema = z.object({
  /** Metres along the field length. */
  x: z.number(),
  /** Metres across the field width. */
  y: z.number(),
  /** Heading in radians, counter-clockwise from the +x axis. */
  headingRad: z.number(),
});
export type Pose = z.infer<typeof PoseSchema>;

/** Planar velocity of a robot. */
export const VelocitySchema = z.object({
  /** Metres per second along x. */
  vx: z.number(),
  /** Metres per second along y. */
  vy: z.number(),
  /** Radians per second, counter-clockwise positive. */
  omega: z.number(),
});
export type Velocity = z.infer<typeof VelocitySchema>;

/** Axis-aligned rectangle in field coordinates (metres). */
export const RectSchema = z.object({
  /** Lower x bound. */
  x0: z.number(),
  /** Lower y bound. */
  y0: z.number(),
  /** Upper x bound. */
  x1: z.number(),
  /** Upper y bound. */
  y1: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/** Euclidean distance between two points, in metres. */
export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Centre of a rectangle. */
export function rectCenter(r: Rect): Vec2 {
  return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
}

/** True when the point lies inside the rectangle (edges inclusive). */
export function inRect(r: Rect, p: Vec2): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

/**
 * Linear interpolation through a table of (x, y) breakpoints sorted by x.
 * Values outside the table are clamped to the first/last breakpoint.
 */
export function interpTable(table: readonly { x: number; y: number }[], x: number): number {
  if (table.length === 0) return 0;
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1]!;
    const b = table[i]!;
    if (x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + t * (b.y - a.y);
    }
  }
  return last.y;
}
