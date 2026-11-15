/**
 * pnpm history:scouting-gen (owner: P5): make the 24 FABRICATED scouting sheets.
 *
 *   1. Sample cfg.ndi.scoutingSheets robot profiles from the archetype templates (seeded), and
 *      write data/scouting/profiles.json: the ground truth, labelled fabricated.
 *   2. Run src/history/ingest/scoutingSheets.mjs, the messy-sheet generator that was written by Intern
 *      (System 2 on DeepInfra, supervised by Drex) as a coding task. It writes
 *      data/scouting/sheets/sNN.{csv,md,txt,html} and data/scouting/truth.json, where truth
 *      lists exactly the fields each sheet states.
 * Everything under data/scouting is fabricated test input; none of it describes a real team.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ARCHETYPES, profileFromTemplate } from "../../contracts";
import { loadConfig, repoPath } from "../../util/config";
import { Rng } from "../../util/rng";

const cfg = loadConfig();
const seed = cfg.league.seed + 77;
const rng = Rng.fromSeed(seed);
const outDir = repoPath("data", "scouting");
mkdirSync(outDir, { recursive: true });

const robots = Array.from({ length: cfg.ndi.scoutingSheets }, (_, i) => {
  const archetype = ARCHETYPES[i % ARCHETYPES.length]!;
  // Team numbers from 20001 up do not belong to any real FRC team.
  const teamNumber = 20001 + i;
  const p = profileFromTemplate(archetype, cfg.archetypes.templates[archetype], { id: `scout_${teamNumber}`, teamLabel: `Team ${teamNumber} (fabricated)` }, cfg.game.fuelMassKg.value, () => rng.next());
  return {
    sheetId: `s${String(i + 1).padStart(2, "0")}`,
    teamNumber,
    archetype,
    profile: {
      shooterType: p.shooterType,
      lanes: p.lanes,
      shootOnMove: p.shootOnMove,
      capacity: p.capacity,
      fireRatePerS: p.fireRatePerS,
      intakeWidth: p.intakeWidth,
      drivetrain: p.drivetrain,
      speedEmptyMps: p.speedEmptyMps,
      massEmptyKg: p.massEmptyKg,
      heightClass: p.heightClass,
      fitsUnderTrench: p.fitsUnderTrench,
      climbLevel: p.climbLevel,
      passRangeM: p.passRangeM,
    },
  };
});

const profilesFile = repoPath("data", "scouting", "profiles.json");
writeFileSync(profilesFile, JSON.stringify({ note: "FABRICATED robots sampled from archetype templates for the scouting-sheet extraction test. Not real teams.", seed, robots }, null, 2) + "\n");
console.log(`[scouting-gen] wrote ${robots.length} fabricated profiles to ${profilesFile}`);

if (!process.argv.includes("--profiles-only")) {
  rmSync(repoPath("data", "scouting", "sheets"), { recursive: true, force: true });
  const out = execFileSync(process.execPath, [repoPath("src", "history", "ingest", "scoutingSheets.mjs"), "--profiles", profilesFile, "--out", outDir, "--seed", String(seed)], { encoding: "utf8" });
  console.log(out.trim());
}
