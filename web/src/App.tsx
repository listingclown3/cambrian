/**
 * Web client shell (owner: P4).
 *
 * STUB: connects to /ws/demo and draws the stub match. P4 replaces this with the real UI,
 * reusing field rendering and panels from vendor/rebuilt-robotsim (Team 488) where it helps.
 */
import { useEffect, useRef, useState } from "react";
import type { EngineEvent, FieldLayout, MatchState } from "../../src/contracts";
import type { ServerMessage } from "../../src/server/protocol";

const RED = "#e5534b";
const BLUE = "#4c8dff";
const CANVAS_W = 1100;

function drawField(canvas: HTMLCanvasElement, state: MatchState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const field: FieldLayout = state.field;
  const scale = CANVAS_W / field.lengthM;
  canvas.width = CANVAS_W;
  canvas.height = Math.round(field.widthM * scale);
  // Field y grows upward; canvas y grows downward.
  const px = (x: number) => x * scale;
  const py = (y: number) => (field.widthM - y) * scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const alliance of ["blue", "red"] as const) {
    const color = alliance === "red" ? RED : BLUE;
    const a = field.alliances[alliance];
    ctx.fillStyle = color + "22";
    ctx.fillRect(px(a.zone.x0), py(a.zone.y1), px(a.zone.x1) - px(a.zone.x0), py(a.zone.y0) - py(a.zone.y1));

    const hub = state.hubs[alliance];
    ctx.beginPath();
    ctx.arc(px(a.hub.x), py(a.hub.y), 0.6 * scale, 0, Math.PI * 2);
    ctx.fillStyle = hub.active ? color : "#3a4250";
    ctx.fill();
    if (hub.warning) {
      ctx.strokeStyle = "#d9a441";
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.fillStyle = color + "aa";
    ctx.fillRect(px(a.tower.x) - 8, py(a.tower.y) - 8, 16, 16);
    ctx.fillStyle = "#8b95a5";
    ctx.font = "11px system-ui";
    ctx.fillText("tower", px(a.tower.x) - 14, py(a.tower.y) - 12);
    ctx.fillText(`depot ${state.fuel.byZone[`${alliance}_depot`]}`, px(a.depot.x) - 18, py(a.depot.y));
    ctx.fillText(`outpost ${state.fuel.byZone[`${alliance}_outpost`]}`, px(a.outpost.x) - 18, py(a.outpost.y));
    ctx.fillText(`loose ${state.fuel.byZone[`${alliance}_alliance`]}`, px((a.zone.x0 + a.zone.x1) / 2) - 20, py(0.25));
  }
  ctx.fillStyle = "#8b95a5";
  ctx.fillText(`neutral fuel ${state.fuel.byZone.neutral}`, px(field.lengthM / 2) - 40, py(0.25));

  ctx.strokeStyle = "#566070";
  ctx.lineWidth = 2;
  for (const lane of field.lanes) {
    ctx.setLineDash(lane.route.endsWith("trench") ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(px(lane.allianceEnd.x), py(lane.allianceEnd.y));
    ctx.lineTo(px(lane.neutralEnd.x), py(lane.neutralEnd.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const spot of field.shotSpots) {
    ctx.beginPath();
    ctx.arc(px(spot.pos.x), py(spot.pos.y), 3, 0, Math.PI * 2);
    ctx.fillStyle = "#566070";
    ctx.fill();
  }
  for (const pile of state.fuel.piles) {
    ctx.beginPath();
    ctx.arc(px(pile.pos.x), py(pile.pos.y), 5, 0, Math.PI * 2);
    ctx.fillStyle = "#d9a441";
    ctx.fill();
  }

  const radius = state.rules.physics.robotRadiusM * scale;
  for (const robot of state.robots) {
    const x = px(robot.pose.x);
    const y = py(robot.pose.y);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = robot.alliance === "red" ? RED : BLUE;
    ctx.fill();
    ctx.strokeStyle = "#0e1116";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(robot.pose.headingRad) * radius, y - Math.sin(robot.pose.headingRad) * radius);
    ctx.stroke();
    ctx.fillStyle = "#e6e9ee";
    ctx.font = "bold 11px system-ui";
    ctx.fillText(`${robot.id} ${robot.fuelHeld}`, x - 14, y - radius - 4);
  }
}

function describeEvent(e: EngineEvent): string {
  const who = "robotId" in e && e.robotId ? ` ${e.robotId}` : "";
  const detail = "action" in e ? ` ${e.action}` : e.kind === "score" ? ` ${e.alliance} +${e.points} (${e.source})` : "";
  return `${e.timeS.toFixed(1).padStart(6)}s  ${e.kind}${who}${detail}`;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<MatchState | null>(null);
  const [hello, setHello] = useState<Extract<ServerMessage, { type: "hello" }> | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws/demo?speed=4`);
    socket.onopen = () => setStatus("live");
    socket.onclose = () => setStatus((s) => (s === "finished" ? s : "disconnected (is the server running?)"));
    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data as string) as ServerMessage;
      if (message.type === "hello") setHello(message);
      else if (message.type === "end") setStatus("finished");
      else {
        setState(message.state);
        const lines = message.events.filter((e) => e.kind !== "score" || e.source === "tower").map(describeEvent);
        if (lines.length > 0) setLog((old) => [...lines.reverse(), ...old].slice(0, 200));
      }
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (state && canvasRef.current) drawField(canvasRef.current, state);
  }, [state]);

  return (
    <div className="page">
      <h1>Cambrian FRC: Drex vs the Giants</h1>
      <div className="muted">FRC REBUILT 2026 strategy simulator. Status: {status}</div>
      {hello && (hello.engineIsStub || hello.isMock) && (
        <div className="banner">
          Scaffold demo: {hello.engineIsStub ? "stub engine" : "real engine"}, scripted controllers, seed {hello.seed}, {hello.speed}x speed. Nothing shown here is a
          result.
        </div>
      )}
      {state && (
        <div className="scoreboard">
          <span className="blue score">{state.score.blue.total}</span>
          <span className="muted">blue</span>
          <span className="red score">{state.score.red.total}</span>
          <span className="muted">red</span>
          <span>
            {state.timeS.toFixed(1)} s, {state.phase}
            {state.shiftIndex ? ` ${state.shiftIndex}` : ""}
          </span>
          <span className="muted">
            hubs: blue {state.hubs.blue.active ? "active" : "inactive"} ({state.hubs.blue.timeToShiftS.toFixed(0)} s), red{" "}
            {state.hubs.red.active ? "active" : "inactive"} ({state.hubs.red.timeToShiftS.toFixed(0)} s)
          </span>
        </div>
      )}
      <canvas ref={canvasRef} width={CANVAS_W} height={540} />
      <div className="columns">
        <div className="panel">
          <h2>Robots</h2>
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>archetype</th>
                <th>fuel</th>
                <th>doing</th>
              </tr>
            </thead>
            <tbody>
              {state?.robots.map((r) => (
                <tr key={r.id}>
                  <td className={r.alliance}>{r.id}</td>
                  <td>{r.profile.archetype}</td>
                  <td>
                    {r.fuelHeld}/{r.profile.capacity}
                  </td>
                  <td>{r.climb.level > 0 ? `hanging L${r.climb.level}` : (r.intent?.action ?? "idle")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Engine events</h2>
          <div className="log">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
