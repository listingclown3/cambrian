/**
 * Field renderer (owner: P4). Draws a MatchState on a canvas: zones, hubs with active/inactive state and a
 * warning pulse, towers, trench and bump lanes, fuel, robots with team label, archetype badge and fuel bar,
 * and short trails. Field layout ideas adapted from FieldView.tsx in Team 488's rebuilt-robotsim
 * (vendor/rebuilt-robotsim), used with permission.
 */
import { useEffect, useRef } from "react";
import type { MatchState } from "../../src/contracts";

const RED = "#ef4444";
const BLUE = "#3b82f6";
const AMBER = "#ffb020";
const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Mono", Consolas, "SF Mono", Menlo, ui-monospace, monospace';

export interface FieldProps {
  state: MatchState | null;
  trails?: Record<string, { x: number; y: number }[]>;
  thinking?: { robotId: string; untilS: number }[];
  /** Robot to ring (scenario focus robot). */
  focusRobotId?: string;
  /** Draw lane and zone captions (turn off for small fields). */
  captions?: boolean;
}

const shortArch = (a: string) => a.replaceAll("_", " ").toUpperCase();
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export function FieldCanvas({ state, trails, thinking, focusRobotId, captions = true }: FieldProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, trails, thinking, focusRobotId, captions });
  live.current = { state, trails, thinking, focusRobotId, captions };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    const loop = () => {
      draw(canvas, live.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const f = state?.field;
  return <canvas ref={ref} className="field-canvas" style={{ aspectRatio: f ? `${f.lengthM} / ${f.widthM}` : "2 / 1" }} aria-label="Field view" />;
}

function draw(canvas: HTMLCanvasElement, p: FieldProps & { captions: boolean }): void {
  const dpr = window.devicePixelRatio || 1;
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
    ctx.fillStyle = "#0b1017";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#6b7a8c";
    ctx.font = `600 ${Math.max(14, cssW / 40)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("waiting for a match", cssW / 2, cssH / 2);
    return;
  }
  const field = state.field;
  const s = cssW / field.lengthM; // px per metre
  const px = (x: number) => x * s;
  const py = (y: number) => (field.widthM - y) * s;
  const now = performance.now();
  const small = cssW < 520;
  const fs = (m: number, min = 9) => Math.max(min, m * s); // font px from metres

  // floor
  ctx.fillStyle = "#0b1017";
  ctx.fillRect(0, 0, cssW, cssH);
  const zoneRect = (r: { x0: number; y0: number; x1: number; y1: number }, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(px(r.x0), py(r.y1), px(r.x1) - px(r.x0), py(r.y0) - py(r.y1));
  };
  zoneRect(field.neutral, "#10171f");
  zoneRect(field.alliances.blue.zone, "rgba(59,130,246,0.10)");
  zoneRect(field.alliances.red.zone, "rgba(239,68,68,0.10)");
  // boundaries
  ctx.strokeStyle = "#263343";
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
    ctx.font = `700 ${fs(0.42, 11)}px ${FONT}`;
    for (const a of ["blue", "red"] as const) {
      const z = field.alliances[a].zone;
      ctx.fillStyle = a === "red" ? "rgba(239,68,68,0.45)" : "rgba(59,130,246,0.5)";
      ctx.fillText(`${a.toUpperCase()} ZONE`, px((z.x0 + z.x1) / 2), py(field.widthM - 0.55));
    }
    ctx.fillStyle = "rgba(139,152,168,0.55)";
    ctx.fillText("NEUTRAL ZONE", px((field.neutral.x0 + field.neutral.x1) / 2), py(field.widthM - 0.55));
  }

  // lanes: trench = solid bar, bump = dashed
  for (const lane of field.lanes) {
    const trench = lane.route.endsWith("trench");
    ctx.strokeStyle = trench ? "#5c6b7e" : "#7a6a3a";
    ctx.lineWidth = Math.max(3, 0.34 * s);
    ctx.setLineDash(trench ? [] : [0.3 * s, 0.22 * s]);
    ctx.beginPath();
    ctx.moveTo(px(lane.allianceEnd.x), py(lane.allianceEnd.y));
    ctx.lineTo(px(lane.neutralEnd.x), py(lane.neutralEnd.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (p.captions && !small) {
    ctx.font = `600 ${fs(0.26, 9)}px ${FONT}`;
    ctx.textAlign = "center";
    const seen = new Set<string>();
    for (const lane of field.lanes) {
      const key = lane.route.replace(/^(left|right)_/, "");
      const k = `${lane.side}${key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ctx.fillStyle = key === "trench" ? "#7d8da2" : "#a89455";
      ctx.fillText(key.toUpperCase(), px((lane.allianceEnd.x + lane.neutralEnd.x) / 2), py((lane.allianceEnd.y + lane.neutralEnd.y) / 2) - 0.28 * s);
    }
  }

  // shot spots
  ctx.fillStyle = "#2a3646";
  for (const sp of field.shotSpots) {
    ctx.beginPath();
    ctx.arc(px(sp.pos.x), py(sp.pos.y), Math.max(2, 0.07 * s), 0, 7);
    ctx.fill();
  }

  // fuel: loose fuel as deterministic dots per zone (capped), counts as text
  const zones = {
    blue_alliance: field.alliances.blue.zone,
    red_alliance: field.alliances.red.zone,
    neutral: field.neutral,
  } as const;
  ctx.fillStyle = "rgba(255,200,60,0.75)";
  let seed = 0;
  for (const [zid, rect] of Object.entries(zones)) {
    const n = Math.min(state.fuel.byZone[zid as keyof typeof zones] ?? 0, 70);
    for (let i = 0; i < n; i++) {
      seed++;
      const x = rect.x0 + 0.3 + hash(seed) * (rect.x1 - rect.x0 - 0.6);
      const y = 0.3 + hash(seed + 999) * (field.widthM - 0.6);
      ctx.beginPath();
      ctx.arc(px(x), py(y), Math.max(1.5, 0.06 * s), 0, 7);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#c9d3df";
  ctx.font = `600 ${fs(0.3, 10)}px ${MONO}`;
  ctx.textAlign = "center";
  const zoneCount = (id: string, rect: { x0: number; x1: number }) => {
    ctx.fillText(`${state.fuel.byZone[id as keyof typeof state.fuel.byZone] ?? 0} fuel`, px((rect.x0 + rect.x1) / 2), py(0.28));
  };
  zoneCount("blue_alliance", field.alliances.blue.zone);
  zoneCount("red_alliance", field.alliances.red.zone);
  zoneCount("neutral", field.neutral);
  for (const pile of state.fuel.piles) {
    ctx.fillStyle = AMBER;
    ctx.beginPath();
    ctx.arc(px(pile.pos.x), py(pile.pos.y), Math.max(4, 0.14 * s), 0, 7);
    ctx.fill();
    ctx.fillStyle = "#0b1017";
    ctx.font = `700 ${fs(0.2, 8)}px ${MONO}`;
    ctx.fillText(String(pile.count), px(pile.pos.x), py(pile.pos.y) + 0.07 * s);
  }
  for (const b of state.fuel.balls) {
    ctx.fillStyle = "#ffe08a";
    ctx.beginPath();
    ctx.arc(px(b.pos.x), py(b.pos.y), Math.max(2, 0.07 * s), 0, 7);
    ctx.fill();
  }

  // per-alliance elements
  for (const a of ["blue", "red"] as const) {
    const el = field.alliances[a];
    const col = a === "red" ? RED : BLUE;
    const hub = state.hubs[a];
    const hx = px(el.hub.x);
    const hy = py(el.hub.y);
    const R = 0.62 * s;
    // glow when active
    if (hub.active) {
      const g = ctx.createRadialGradient(hx, hy, R * 0.5, hx, hy, R * 2.1);
      g.addColorStop(0, col + "66");
      g.addColorStop(1, col + "00");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, R * 2.1, 0, 7);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(hx, hy, R, 0, 7);
    ctx.fillStyle = hub.active ? col : "#18212b";
    ctx.fill();
    ctx.lineWidth = Math.max(3, 0.09 * s);
    ctx.strokeStyle = hub.active ? "#ffffff" : col + "99";
    ctx.stroke();
    if (hub.warning) {
      const pulse = (Math.sin(now / 110) + 1) / 2;
      ctx.beginPath();
      ctx.arc(hx, hy, R * (1.15 + pulse * 0.45), 0, 7);
      ctx.strokeStyle = `rgba(255,176,32,${0.95 - pulse * 0.6})`;
      ctx.lineWidth = Math.max(3, 0.12 * s);
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.fillStyle = hub.active ? "#fff" : "#8b98a8";
    ctx.font = `800 ${fs(0.3, 10)}px ${FONT}`;
    ctx.fillText("HUB", hx, hy - 0.02 * s);
    ctx.font = `700 ${fs(0.26, 9)}px ${MONO}`;
    ctx.fillText(`${hub.active ? "ON" : "OFF"} ${hub.timeToShiftS.toFixed(0)}s`, hx, hy + 0.3 * s);

    // tower
    const tx = px(el.tower.x);
    const ty = py(el.tower.y);
    const tw = 0.7 * s;
    ctx.fillStyle = "#151d27";
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.fillRect(tx - tw / 2, ty - tw / 2, tw, tw);
    ctx.strokeRect(tx - tw / 2, ty - tw / 2, tw, tw);
    if (p.captions) {
      ctx.fillStyle = "#8b98a8";
      ctx.font = `700 ${fs(0.24, 9)}px ${FONT}`;
      ctx.fillText("TOWER", tx, ty + tw / 2 + 0.28 * s);
    }
    // depot + outpost
    for (const [name, pos] of [["DEPOT", el.depot], ["OUTPOST", el.outpost]] as const) {
      const bw = 0.8 * s;
      const bh = 0.5 * s;
      ctx.strokeStyle = col + "88";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px(pos.x) - bw / 2, py(pos.y) - bh / 2, bw, bh);
      if (p.captions) {
        ctx.fillStyle = "#6f7e90";
        ctx.font = `700 ${fs(0.2, 8)}px ${FONT}`;
        const n = state.fuel.byZone[`${a}_${name.toLowerCase()}` as keyof typeof state.fuel.byZone] ?? 0;
        ctx.fillText(`${name} ${n}`, px(pos.x), py(pos.y) + 0.07 * s);
      }
    }
  }

  // trails
  if (p.trails) {
    for (const r of state.robots) {
      const t = p.trails[r.id];
      if (!t || t.length < 2) continue;
      const col = r.alliance === "red" ? "239,68,68" : "59,130,246";
      for (let i = 1; i < t.length; i++) {
        ctx.strokeStyle = `rgba(${col},${(i / t.length) * 0.5})`;
        ctx.lineWidth = Math.max(2, 0.12 * s) * (i / t.length);
        ctx.beginPath();
        ctx.moveTo(px(t[i - 1]!.x), py(t[i - 1]!.y));
        ctx.lineTo(px(t[i]!.x), py(t[i]!.y));
        ctx.stroke();
      }
    }
  }

  // robots
  const rr = state.rules.physics.robotRadiusM * s;
  for (const r of state.robots) {
    const x = px(r.pose.x);
    const y = py(r.pose.y);
    const col = r.alliance === "red" ? RED : BLUE;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, 7);
    ctx.fillStyle = "#0d141c";
    ctx.fill();
    ctx.lineWidth = Math.max(4, rr * 0.34); // bumper
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#e8edf3";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(r.pose.headingRad) * rr, y - Math.sin(r.pose.headingRad) * rr);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.max(11, rr * 0.9)}px ${FONT}`;
    ctx.fillText(r.id, x, y + rr * 0.3);
    if (p.focusRobotId === r.id) {
      ctx.strokeStyle = AMBER;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, rr * 1.7, 0, 7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (p.thinking?.some((t) => t.robotId === r.id)) {
      const ph = (now / 600) % 1;
      ctx.strokeStyle = `rgba(255,176,32,${1 - ph})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, rr * (1.2 + ph * 0.8), 0, 7);
      ctx.stroke();
    }
    // fuel bar
    const cap = Math.max(1, r.profile.capacity);
    const bw = rr * 2.2;
    const bh = Math.max(4, rr * 0.22);
    const by = y + rr * 1.35;
    ctx.fillStyle = "#1b2531";
    ctx.fillRect(x - bw / 2, by, bw, bh);
    ctx.fillStyle = AMBER;
    ctx.fillRect(x - bw / 2, by, bw * Math.min(1, r.fuelHeld / cap), bh);
    if (!small) {
      ctx.fillStyle = "#c9d3df";
      ctx.font = `700 ${Math.max(9, rr * 0.5)}px ${FONT}`;
      ctx.fillText(`${r.profile.teamLabel}`, x, y - rr * 1.45);
      ctx.fillStyle = "#7d8da2";
      ctx.font = `700 ${Math.max(8, rr * 0.36)}px ${FONT}`;
      ctx.fillText(`${shortArch(r.profile.archetype)} · ${r.fuelHeld}/${cap}`, x, by + bh + rr * 0.5);
    }
  }
}
