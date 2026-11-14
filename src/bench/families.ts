/**
 * pnpm families (owner: P3)
 * Turn every mined base scenario (data/scenarios/mined.json) into a ScenarioFamily: the base plus
 * one-flip variants, each changing exactly ONE fact by editing the snapshot state:
 *   hub   - (shift phase only) swap which alliance's hub is active this shift
 *           (state.firstInactiveAlliance swapped, hub flags recomputed); time is unchanged
 *   fuel  - focus robot's hopper emptied (if it held fuel) or filled to half capacity (if empty)
 *   opp   - the nearest opponent within 4 m (or the one in contact) is moved to its own
 *           alliance zone centre, contact and pin timers cleared ("opponent absent")
 *   time  - (endgame families only) time remaining changed: >= 20 s left -> 8 s left, else 28 s
 * Options of every variant are re-curated by the same fixed rule (curateOptions), since the
 * legal options change with the state.
 *
 * Writes data/scenarios/scenarios.json (families + scenarios, no answer keys yet).
 */
import { dist, rectCenter, otherAlliance, type MatchState, type Scenario, type ScenarioFamily, type Snapshot } from "../contracts";
import { engine } from "../engine";
import { loadConfig } from "../util/config";
import { simHash } from "../util/provenance";
import { ScenarioSetSchema, curateOptions, readJson, writeJson } from "./common";

const cfg = loadConfig();
const mined = readJson<{ bases: { id: string; stickyType: string; matchId: string; seed: number; timeS: number; focusRobotId: string; snapshot: Snapshot; options: Scenario["options"] }[] }>("data", "scenarios", "mined.json");
if (!mined) throw new Error("data/scenarios/mined.json is missing: run pnpm mine first");

const DESCRIPTIONS: Record<string, string> = {
  hub_about_to_deactivate: "The robot holds fuel and its alliance's hub deactivates within 5 seconds.",
  contact_while_loaded: "The robot is in contact with (or pinned by) another robot while carrying at least half a hopper.",
  full_far_from_hub: "The hopper is (nearly) full and the robot is far outside its shot range.",
  hub_inactive_loaded: "The robot carries at least half a hopper while its hub stays inactive for 6 s or more.",
  blocked_no_progress: "The robot's path is blocked or it is making no progress.",
  endgame_climb_or_cycle: "End game with 12-30 s left: climb now or score one more cycle.",
  defended: "An opponent is defending the robot.",
};

type Flip = { key: string; words: string; apply: (s: MatchState, focus: string) => boolean };

function recomputeHubWarnings(s: MatchState): void {
  for (const a of ["red", "blue"] as const) {
    const hub = s.hubs[a]!;
    hub.warning = hub.active && hub.timeToShiftS <= s.rules.hubWarningS && hub.timeToShiftS < s.rules.matchS - s.timeS - 1e-9;
  }
}

const FLIPS: Flip[] = [
  {
    key: "hub",
    words: "",
    apply(s, focus) {
      if (s.phase !== "shift" || s.firstInactiveAlliance === null) return false;
      s.firstInactiveAlliance = otherAlliance(s.firstInactiveAlliance);
      for (const a of ["red", "blue"] as const) s.hubs[a]!.active = !s.hubs[a]!.active;
      recomputeHubWarnings(s);
      const r = s.robots.find((x) => x.id === focus)!;
      this.words = `our hub is ${s.hubs[r.alliance]!.active ? "ACTIVE" : "INACTIVE"} this shift instead of ${s.hubs[r.alliance]!.active ? "inactive" : "active"} (which alliance's hub is active was swapped; time unchanged)`;
      return true;
    },
  },
  {
    key: "fuel",
    words: "",
    apply(s, focus) {
      const r = s.robots.find((x) => x.id === focus)!;
      if (r.profile.capacity <= 0) return false;
      const before = r.fuelHeld;
      r.fuelHeld = before > 0 ? 0 : Math.max(1, Math.round(r.profile.capacity / 2));
      r.accum.shot = 0;
      this.words = `the robot holds ${r.fuelHeld} fuel instead of ${before}`;
      return true;
    },
  },
  {
    key: "opp",
    words: "",
    apply(s, focus) {
      const r = s.robots.find((x) => x.id === focus)!;
      const opps = s.robots.filter((o) => o.alliance !== r.alliance).sort((a, b) => dist(a.pose, r.pose) - dist(b.pose, r.pose));
      const target = opps.find((o) => o.id === r.contact.withRobotId || o.id === r.contact.pinnedByRobotId) ?? opps[0];
      if (!target || dist(target.pose, r.pose) > 4) return false;
      const before = dist(target.pose, r.pose);
      const home = rectCenter(s.field.alliances[target.alliance]!.zone);
      target.pose = { ...target.pose, x: home.x, y: home.y };
      target.velocity = { ...target.velocity, vx: 0, vy: 0 } as typeof target.velocity;
      target.navTarget = null;
      target.noProgressS = 0;
      for (const x of s.robots) {
        if (x.id === target.id || x.contact.withRobotId === target.id || x.contact.pinnedByRobotId === target.id) {
          x.contact = { withRobotId: null, contactS: 0, pinnedByRobotId: null, pinS: 0 };
        }
      }
      this.words = `opponent ${target.id} (${before.toFixed(1)} m away) is absent: moved to its own alliance zone`;
      return true;
    },
  },
  {
    key: "time",
    words: "",
    apply(s) {
      if (s.phase !== "endgame") return false;
      const before = s.rules.matchS - s.timeS;
      const after = before >= 20 ? 8 : 28;
      s.timeS = s.rules.matchS - after;
      for (const a of ["red", "blue"] as const) s.hubs[a]!.timeToShiftS = after;
      recomputeHubWarnings(s);
      this.words = `${after} s left in the match instead of ${before.toFixed(0)} s`;
      return true;
    },
  },
];

const families: ScenarioFamily[] = [];
const scenarios: Scenario[] = [];
for (const base of mined.bases) {
  const familyId = `fam_${base.id}`;
  families.push({ id: familyId, stickyType: base.stickyType, description: DESCRIPTIONS[base.stickyType] ?? base.stickyType, baseScenarioId: base.id });
  scenarios.push({ id: base.id, familyId, flip: "", snapshot: base.snapshot, focusRobotId: base.focusRobotId, options: base.options });
  for (const flip of FLIPS) {
    const state = engine.restore(base.snapshot);
    if (!flip.apply(state, base.focusRobotId)) continue;
    const options = curateOptions(state, base.focusRobotId);
    if (options.length < 2) continue;
    const snapshot = engine.snapshot(state);
    scenarios.push({ id: `${base.id}__${flip.key}`, familyId, flip: flip.words, snapshot, focusRobotId: base.focusRobotId, options });
  }
}

const set = ScenarioSetSchema.parse({
  generatedTs: new Date().toISOString(),
  simHash: simHash(cfg),
  note: "Base scenarios are mined from dev-seed scripted matches; variants flip exactly one fact by editing the snapshot. answerKey is filled by pnpm answerkey.",
  families,
  scenarios,
});
const file = writeJson(set, "data", "scenarios", "scenarios.json");
for (const s of scenarios) console.log(`[families] ${s.id.padEnd(40)} ${s.options.length} options${s.flip ? `  flip: ${s.flip}` : ""}`);
console.log(`[families] ${families.length} families, ${scenarios.length} scenarios -> ${file}`);
