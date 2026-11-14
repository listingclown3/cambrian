/**
 * Headless responsiveness check for replay: feed a full recorded match through the server replay slices and the
 * client reducer, and assert no slice (server work + JSON round trip + reducer) is long enough to freeze a tab.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduce, type MatchView } from "../../web/src/matchReducer";
import { ENGINE_IS_STUB } from "../engine";
import { repoPath } from "../util/config";
import type { ServerMessage, SlimStatic } from "./protocol";
import { ReplaySim } from "./replaySim";
import { readRunEvents } from "./runs";

describe("replay stays responsive", () => {
  it("a full recorded match plays in slices that are each far below one frame budget", () => {
    const t0 = performance.now();
    const events = readRunEvents(repoPath("src", "server", "fixtures", "showcase_fixture", "events.jsonl"));
    const parseMs = performance.now() - t0;
    const speed = 6;
    const sim = new ReplaySim(events, { runId: "showcase_fixture", isFixture: true, speed, engineIsStub: ENGINE_IS_STUB });
    const ticks = Math.max(1, Math.round((speed * 50) / 1000 / 0.05));
    const statics: { current: SlimStatic | null } = { current: null };
    const counter = { n: 0 };
    let view: MatchView = reduce(EMPTY_VIEW, JSON.parse(JSON.stringify(sim.hello)) as ServerMessage, counter, statics);
    const slices: number[] = [];
    let bytes = 0;
    let guard = 0;
    while (!sim.finished && guard++ < 100_000) {
      const s0 = performance.now();
      for (const m of sim.frame(ticks)) {
        const wire = JSON.stringify(m);
        bytes += wire.length;
        view = reduce(view, JSON.parse(wire) as ServerMessage, counter, statics);
      }
      slices.push(performance.now() - s0);
    }
    slices.sort((a, b) => a - b);
    const p99 = slices[Math.floor(slices.length * 0.99)]!;
    console.log(`replay: parse ${parseMs.toFixed(0)} ms, ${slices.length} slices, p50 ${slices[slices.length >> 1]!.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${slices.at(-1)!.toFixed(1)} ms, ${(bytes / slices.length / 1024).toFixed(1)} KB per frame`);
    expect(view.status).toBe("finished");
    expect(view.ticker.length).toBeLessThanOrEqual(6);
    expect(parseMs).toBeLessThan(1000);
    expect(p99).toBeLessThan(50);
    expect(slices.at(-1)!).toBeLessThan(250);
  });
});
