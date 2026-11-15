import { describe, expect, it } from "vitest";
import { internArgs, parseInternEvents, runIntern, summarizeInternEvents } from "./intern-client";

// Shapes taken from a real `intern -p --json` run (Intern 0.30.1, protocol_version 2), trimmed.
const stream = [
  '{"timestamp":1,"type":"run_start","protocol_version":2,"session_id":"338c45a35e61","run_id":"16fa773c5cd7","model":"deepinfra/Qwen/Qwen3.8-27B","cwd":"/home/x/ws"}',
  '{"timestamp":2,"type":"turn_start","turn":1}',
  '{"timestamp":3,"type":"reasoning_delta","turn":1,"text":"The"}',
  '{"timestamp":4,"type":"tool_call_start","turn":1,"call_id":"c1","name":"write","arguments":{"path":"hello.json"}}',
  '{"timestamp":5,"type":"tool_call_end","turn":1,"call_id":"c1","name":"write","status":"ok","content":"Created hello.json (1 lines).","duration_ms":1}',
  '{"timestamp":6,"type":"decision","purpose":"supervise","backend":"decisions-api:drex-latest","questions":1,"ok":true,"cached":false,"cost_usd":0,"input_tokens":481,"output_tokens":198,"duration_ms":266,"error":null,"turn":1,"answers":{"mode":{"choice":"advance"}}}',
  '{"timestamp":7,"type":"decision","purpose":"supervise","backend":"decisions-api:drex-latest","questions":2,"ok":true,"cached":true,"cost_usd":0,"input_tokens":470,"output_tokens":190,"duration_ms":0,"error":null,"turn":2,"answers":{}}',
  '{"timestamp":8,"type":"turn_start","turn":2}',
  '{"timestamp":9,"type":"text_delta","turn":2,"text":"\\n\\ndo"}',
  '{"timestamp":10,"type":"text_delta","turn":2,"text":"ne"}',
  "this line is not json and must be ignored",
  '{"timestamp":11,"type":"run_end","run_id":"16fa773c5cd7","reason":"completed","detail":null,"turns":2,"usage":{"input_tokens":5677,"output_tokens":146,"cache_read_tokens":3136,"reasoning_tokens":0,"cost_usd":0}}',
  '{"ok":true}',
].join("\n");

describe("intern-client", () => {
  it("parses the event stream and ignores non-event lines", () => {
    const events = parseInternEvents(stream);
    expect(events).toHaveLength(11);
    expect(events[0]!.type).toBe("run_start");
  });

  it("summarises a run: turns, reply, tool calls, System 2 usage and System 1 judgments", () => {
    const s = summarizeInternEvents(parseInternEvents(stream));
    expect(s).toMatchObject({ reason: "completed", runId: "16fa773c5cd7", sessionId: "338c45a35e61", model: "deepinfra/Qwen/Qwen3.8-27B", turns: 2, text: "done" });
    expect(s.toolCalls).toEqual([{ name: "write", status: "ok", durationMs: 1 }]);
    expect(s.system2).toMatchObject({ inputTokens: 5677, outputTokens: 146, cacheReadTokens: 3136 });
    // cached decisions are listed but not counted as real calls
    expect(s.system1.decisions).toHaveLength(2);
    expect(s.system1).toMatchObject({ calls: 1, judgments: 1, inputTokens: 481, errors: 0 });
  });

  it("reports a stream with no run_end", () => {
    expect(summarizeInternEvents([]).reason).toBe("no_run_end");
  });

  it("builds headless arguments", () => {
    expect(internArgs({ command: ["intern"], system2: "deepinfra/M", system1: "drex-latest", task: "t", internCwd: "/ws", maxTurns: 5 })).toEqual([
      "-p", "--json", "--system2", "deepinfra/M", "--system1", "drex-latest", "--cwd", "/ws", "--max-turns", "5", "--no-session", "--no-memory",
    ]);
  });

  it("does not throw when the command cannot be started", async () => {
    const run = await runIntern({ command: ["definitely-not-a-real-command-xyz"], system2: "a/b", task: "t", timeoutMs: 5000 });
    expect(run.ok).toBe(false);
    expect(run.reason).toBe("spawn_error");
  });
});
