/**
 * Field renderer (owner: P4). Draws a MatchState on one canvas: zones, hubs (active hub glows in the lane accent,
 * warning pulse in the last seconds), towers, trench and bump lanes, fuel as yellow dots, robots as bumpered rounded
 * squares with an archetype letter, dotted paths in the lane accent, and a "thinking" marker. Alliance colours are
 * used only on robot bumpers. Field layout ideas adapted from FieldView.tsx in Team 488's rebuilt-robotsim
 * (vendor/rebuilt-robotsim), used with permission.
 */
import { useEffect, useRef } from "react";
import type { MatchState } from "../../src/contracts";

const RED = "#d84a4a";
const BLUE = "#3b7de0";
const AMBER = "#f5a524";
const FUEL = "#ffd43b";
const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

export interface FieldProps {
  state: MatchState | null;
  trails?: Record<string, { x: number; y: number }[]>;
  thinking?: { robotId: string; untilS: number }[];
  /** Robot to ring (scenario focus robot). */
  focusRobotId?: string;
  /** Lane accent colour (Drex amber, giant cyan); used for hub glow and dotted paths. */
  accent?: string;
  /** Draw lane and zone captions (turn off for small fields). */
  captions?: boolean;
}

/** One letter per archetype for the robot marker. */
export function archLetter(archetype: string): string {
  if (archetype.startsWith("turret")) return "T";
  if (archetype.startsWith("drum")) return "D";
  if (archetype.startsWith("multilane")) return "M";
  if (archetype.startsWith("big_hopper")) return "H";
  return "X";
}

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

type Live = FieldProps & { accent: string; captions: boolean };

export function FieldCanvas({ state, trails, thinking, focusRobotId, accent = AMBER, captions = true }: FieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>({ state, trails, thinking, focusRobotId, accent, captions });
  live.current = { state, trails, thinking, focusRobotId, accent, captions };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      // about 30 fps is plenty and keeps the main thread free
      if (t - last > 30) {
        last = t;
        draw(canvas, live.current);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const f = state?.field;
  return <canvas ref={ref} className="field-canvas" style={{ aspectRatio: f ? `${f.lengthM} / ${f.widthM}` : "2 / 1" }} aria-label="Field view" />;
}

function rgba(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Presentation only: short marks for fuel leaving a robot, inferred from frame-to-frame changes in
 * the replayed state (the engine resolves shots and passes instantly, so there is nothing in flight
 * to draw). A drop matched by a nearby teammate's gain is drawn as a pass; a drop while the
 * alliance's score rises is drawn as a shot into the hub; any other drop (a miss, a shot at an
 * inactive hub, a pass to a zone, a dump) is drawn as a plain ring at the robot.
 */
type Fx = { kind: "shot" | "pass" | "release"; x0: number; y0: number; x1: number; y1: number; t0: number };
type FxMem = { timeS: number; fuel: Map<string, number>; score: { red: number; blue: number }; fx: Fx[] };
const fxMem = new WeakMap<HTMLCanvasElement, FxMem>();
const FX_MS = 480;

function updateFx(canvas: HTMLCanvasElement, state: MatchState, now: number): Fx[] {
  const score = { red: state.score.red.total, blue: state.score.blue.total };
  const fuel = new Map(state.robots.map((r) => [r.id, r.fuelHeld] as const));
  const m = fxMem.get(canvas);
  if (!m) {
    fxMem.set(canvas, { timeS: state.timeS, fuel, score, fx: [] });
    return [];
  }
  const dt = state.timeS - m.timeS;
  if (dt > 0 && dt < 3) {
    for (const r of state.robots) {
      const drop = (m.fuel.get(r.id) ?? r.fuelHeld) - r.fuelHeld;
      if (drop <= 0) continue;
      const range = (r.profile.passRangeM ?? 3) + 0.5;
      const mate = state.robots.find((o) => {
        if (o.id === r.id || o.alliance !== r.alliance) return false;
        const gain = o.fuelHeld - (m.fuel.get(o.id) ?? o.fuelHeld);
        return gain > 0 && Math.abs(gain - drop) <= Math.max(1, drop * 0.5) && Math.hypot(o.pose.x - r.pose.x, o.pose.y - r.pose.y) <= range;
      });
      const hub = state.field.alliances[r.alliance].hub;
      if (mate) m.fx.push({ kind: "pass", x0: r.pose.x, y0: r.pose.y, x1: mate.pose.x, y1: mate.pose.y, t0: now });
      else if (score[r.alliance] > m.score[r.alliance]) m.fx.push({ kind: "shot", x0: r.pose.x, y0: r.pose.y, x1: hub.x, y1: hub.y, t0: now });
      else m.fx.push({ kind: "release", x0: r.pose.x, y0: r.pose.y, x1: r.pose.x, y1: r.pose.y, t0: now });
    }
  } else if (dt !== 0) m.fx = [];
  if (dt !== 0) {
    m.timeS = state.timeS;
    m.fuel = fuel;
    m.score = score;
  }
  m.fx = m.fx.filter((e) => now - e.t0 < FX_MS).slice(-40);
  return m.fx;
}

function draw(canvas: HTMLCanvasElement, p: Live): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const state = p.state;
  if (!state) {
    ctx.fillStyle = "#0f141b";
    ctx.fillRect(0, 0, cssW, cssH);
    return;
  }
  const field = state.field;
  const s = cssW / field.lengthM; // px per metre
  const px = (x: number) => x * s;
  const py = (y: number) => (field.widthM - y) * s;
  const now = performance.now();
  const small = cssW < 520;
  const fs = (m: number, min = 9) => Math.max(min, m * s);
  const accent = p.accent;

  ctx.fillStyle = "#0f141b";
  ctx.fillRect(0, 0, cssW, cssH);
  const zoneRect = (r: { x0: number; y0: number; x1: number; y1: number }, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(px(r.x0), py(r.y1), px(r.x1) - px(r.x0), py(r.y0) - py(r.y1));
  };
  zoneRect(field.neutral, "#131a23");
  zoneRect(field.alliances.blue.zone, "#111821");
  zoneRect(field.alliances.red.zone, "#111821");
  ctx.strokeStyle = "#222b37";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, cssW - 2, cssH - 2);
  for (const x of [field.alliances.blue.zone.x1, field.alliances.red.zone.x0]) {
    ctx.beginPath();
    ctx.moveTo(px(x), 0);
    ctx.lineTo(px(x), cssH);
    ctx.stroke();
  }
  if (p.captions) {
    ctx.textAlign = "center";
    ctx.font = `700 ${fs(0.36, 10)}px ${FONT}`;
    ctx.fillStyle = "rgba(138,150,166,0.5)";
    for (const a of ["blue", "red"] as const) {
      const z = field.alliances[a].zone;
      ctx.fillText(`${a.toUpperCase()} ZONE`, px((z.x0 + z.x1) / 2), py(field.widthM - 0.5));
    }
    ctx.fillText("NEUTRAL ZONE", px((field.neutral.x0 + field.neutral.x1) / 2), py(field.widthM - 0.5));
  }

  for (const lane of field.lanes) {
    const trench = lane.route.endsWith("trench");
    ctx.strokeStyle = trench ? "#3a4757" : "#5a4d2a";
    ctx.lineWidth = Math.max(3, 0.3 * s);
    ctx.setLineDash(trench ? [] : [0.3 * s, 0.22 * s]);
    ctx.beginPath();
    ctx.moveTo(px(lane.allianceEnd.x), py(lane.allianceEnd.y));
    ctx.lineTo(px(lane.neutralEnd.x), py(lane.neutralEnd.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // fuel: yellow dots per zone (capped, deterministic), counts as text
  const zones = { blue_alliance: field.alliances.blue.zone, red_alliance: field.alliances.red.zone, neutral: field.neutral } as const;
  ctx.fillStyle = FUEL;
  let seed = 0;
  for (const [zid, rect] of Object.entries(zones)) {
    const n = Math.min(state.fuel.byZone[zid as keyof typeof zones] ?? 0, 60);
    for (let i = 0; i < n; i++) {
      seed++;
      const x = rect.x0 + 0.3 + hash(seed) * (rect.x1 - rect.x0 - 0.6);
      const y = 0.3 + hash(seed + 999) * (field.widthM - 0.6);
      ctx.beginPath();
      ctx.arc(px(x), py(y), Math.max(1.6, 0.055 * s), 0, 7);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#a9b4c2";
  ctx.font = `600 ${fs(0.28, 10)}px ${MONO}`;
  ctx.textAlign = "center";
  const zoneCount = (id: keyof typeof zones, rect: { x0: number; x1: number }) => ctx.fillText(`${state.fuel.byZone[id] ?? 0} fuel`, px((rect.x0 + rect.x1) / 2), py(0.25));
  zoneCount("blue_alliance", field.alliances.blue.zone);
  zoneCount("red_alliance", field.alliances.red.zone);
  zoneCount("neutral", field.neutral);
  for (const pile of state.fuel.piles) {
    ctx.fillStyle = FUEL;
    ctx.beginPath();
    ctx.arc(px(pile.pos.x), py(pile.pos.y), Math.max(4, 0.13 * s), 0, 7);
    ctx.fill();
  }
  for (const b of state.fuel.balls) {
    ctx.fillStyle = "#ffe58a";
    ctx.beginPath();
    ctx.arc(px(b.pos.x), py(b.pos.y), Math.max(2, 0.065 * s), 0, 7);
    ctx.fill();
  }

  for (const a of ["blue", "red"] as const) {
    const el = field.alliances[a];
    const hub = state.hubs[a];
    const hx = px(el.hub.x);
    const hy = py(el.hub.y);
    const R = 0.6 * s;
    if (hub.active) {
      const g = ctx.createRadialGradient(hx, hy, R * 0.4, hx, hy, R * 2.3);
      g.addColorStop(0, rgba(accent, 0.55));
      g.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, R * 2.3, 0, 7);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(hx, hy, R, 0, 7);
    ctx.fillStyle = hub.active ? rgba(accent, 0.9) : "#18212b";
    ctx.fill();
    ctx.lineWidth = Math.max(2.5, 0.08 * s);
    ctx.strokeStyle = hub.active ? "#fff" : "#3a4757";
    ctx.stroke();
    if (hub.warning) {
      const pulse = (Math.sin(now / 110) + 1) / 2;
      ctx.beginPath();
      ctx.arc(hx, hy, R * (1.15 + pulse * 0.45), 0, 7);
      ctx.strokeStyle = `rgba(255,255,255,${0.9 - pulse * 0.6})`;
      ctx.lineWidth = Math.max(3, 0.1 * s);
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = hub.active ? "#0b0e13" : "#8a96a6";
    ctx.font = `800 ${fs(0.28, 10)}px ${FONT}`;
    ctx.fillText("HUB", hx, hy - 0.02 * s);
    ctx.font = `700 ${fs(0.24, 9)}px ${MONO}`;
    ctx.fillText(`${hub.active ? "ON" : "OFF"} ${hub.timeToShiftS.toFixed(0)}s`, hx, hy + 0.28 * s);

    const tx = px(el.tower.x);
    const ty = py(el.tower.y);
    const tw = 0.7 * s;
    ctx.fillStyle = "#151d27";
    ctx.strokeStyle = "#3a4757";
    ctx.lineWidth = 2;
    ctx.fillRect(tx - tw / 2, ty - tw / 2, tw, tw);
    ctx.strokeRect(tx - tw / 2, ty - tw / 2, tw, tw);
    if (p.captions) {
      ctx.fillStyle = "#8a96a6";
      ctx.font = `700 ${fs(0.22, 8)}px ${FONT}`;
      ctx.fillText("TOWER", tx, ty + tw / 2 + 0.26 * s);
    }
    for (const [name, pos] of [["DEPOT", el.depot], ["OUTPOST", el.outpost]] as const) {
      const bw = 0.8 * s;
      const bh = 0.5 * s;
      ctx.strokeStyle = "#2a3646";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px(pos.x) - bw / 2, py(pos.y) - bh / 2, bw, bh);
      if (p.captions) {
        ctx.fillStyle = "#6f7e90";
        ctx.font = `700 ${fs(0.18, 8)}px ${FONT}`;
        const n = state.fuel.byZone[`${a}_${name.toLowerCase()}` as keyof typeof state.fuel.byZone] ?? 0;
        ctx.fillText(`${name} ${n}`, px(pos.x), py(pos.y) + 0.06 * s);
      }
    }
  }

  // dotted paths since the last decision, in the lane accent
  if (p.trails) {
    ctx.fillStyle = accent;
    for (const r of state.robots) {
      const t = p.trails[r.id];
      if (!t) continue;
      for (let i = 0; i < t.length; i++) {
        ctx.globalAlpha = 0.25 + 0.65 * ((i + 1) / t.length);
        ctx.beginPath();
        ctx.arc(px(t[i]!.x), py(t[i]!.y), Math.max(1.8, 0.05 * s), 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // fuel leaving a robot: shot streak into the hub, dashed pass line to a teammate, or a plain ring
  for (const e of updateFx(canvas, state, now)) {
    const k = Math.min(1, (now - e.t0) / FX_MS);
    ctx.globalAlpha = 1 - k * 0.85;
    if (e.kind === "release") {
      ctx.strokeStyle = "#a9b4c2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px(e.x0), py(e.y0), state.rules.physics.robotRadiusM * s * (1.1 + k * 0.9), 0, 7);
      ctx.stroke();
      continue;
    }
    const col = e.kind === "shot" ? FUEL : "#eef1f4";
    ctx.strokeStyle = col;
    ctx.lineWidth = e.kind === "shot" ? 2 : 2.5;
    ctx.setLineDash(e.kind === "pass" ? [7, 5] : []);
    ctx.beginPath();
    ctx.moveTo(px(e.x0), py(e.y0));
    ctx.lineTo(px(e.x1), py(e.y1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    for (const lag of [0, 0.18, 0.36]) {
      const t = Math.min(1, Math.max(0, k * 1.5 - lag));
      ctx.beginPath();
      ctx.arc(px(e.x0 + (e.x1 - e.x0) * t), py(e.y0 + (e.y1 - e.y0) * t), Math.max(2.5, 0.075 * s), 0, 7);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // robots: bumpered rounded squares with an archetype letter
  const rr = state.rules.physics.robotRadiusM * s;
  for (const r of state.robots) {
    const x = px(r.pose.x);
    const y = py(r.pose.y);
    const col = r.alliance === "red" ? RED : BLUE;
    const side = rr * 1.7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-r.pose.headingRad);
    ctx.beginPath();
    ctx.roundRect(-side / 2, -side / 2, side, side, side * 0.22);
    ctx.fillStyle = "#0b0e13";
    ctx.fill();
    ctx.lineWidth = Math.max(4, rr * 0.32);
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.fillStyle = "#eef1f4";
    ctx.fillRect(side / 2 - 2, -side * 0.18, 4, side * 0.36); // front marker
    ctx.restore();
    ctx.textAlign = "center";
    ctx.fillStyle = "#eef1f4";
    ctx.font = `700 ${Math.max(11, rr * 0.95)}px ${MONO}`;
    ctx.fillText(archLetter(r.profile.archetype), x, y + rr * 0.33);
    if (p.focusRobotId === r.id) {
      ctx.strokeStyle = accent;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, rr * 1.7, 0, 7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (p.thinking?.some((t) => t.robotId === r.id)) {
      ctx.font = `600 ${Math.max(10, rr * 0.5)}px ${FONT}`;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 250);
      ctx.fillText("thinking…", x, y - rr * 1.3);
      ctx.globalAlpha = 1;
    }
    const cap = Math.max(1, r.profile.capacity);
    const bw = rr * 2;
    const bh = Math.max(3, rr * 0.2);
    const by = y + rr * 1.15;
    ctx.fillStyle = "#1b2531";
    ctx.fillRect(x - bw / 2, by, bw, bh);
    ctx.fillStyle = FUEL;
    ctx.fillRect(x - bw / 2, by, bw * Math.min(1, r.fuelHeld / cap), bh);
    if (!small) {
      ctx.fillStyle = "#a9b4c2";
      ctx.font = `600 ${Math.max(9, rr * 0.45)}px ${FONT}`;
      ctx.fillText(r.id, x, by + bh + rr * 0.5);
    }
  }
}
