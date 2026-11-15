/**
 * pnpm archive: seed the REBUILT quirk archive from the hackathon outputs and write
 * results/archive.json.
 *
 *   results/quirks.json  every judged quirk (5 lab proposals, tower post-up, 5 Intern rule scans)
 *   results/lab.json     the lab proposals' intents and per-seed margin differences
 *
 * Only what those files measured is carried over. They did not record start or end conditions,
 * so seeded nodes have none (they start chains but are not linked automatically), except the
 * tower post-up, whose start conditions are the ones its experiment used (src/search/proposals/
 * towerPostUp.ts: last 30 s of the match, fuel held). No prior prediction of the effect was
 * recorded either, so `predicted` is null throughout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Condition, Legality, QuirkNode } from "../contracts";
import { repoPath } from "../util/config";
import { QuirkArchive } from "./graph";

const UNIT = "match margin vs scripted baseline (points)";
const KNOWN_START: Record<string, Condition[]> = {
  tower_post_up: [
    { key: "matchRemainingS", op: "lte", value: 30 },
    { key: "fuelHeld", op: "gt", value: 0 },
  ],
};
const EXTRA_NOTES: Record<string, string> = {
  trench_shoot_on_move_refill: "Part of this gain comes from the G407 gap (scoring from the neutral side): on branch g407 the same strategy measures +103.7 +/- 21.3.",
  tower_post_up: "The opponent (basic_cycle) never defends, so no G420 foul could be drawn; margins were identical on all 10 seeds. Rerun against archetype_v1 before using this as evidence.",
};

interface QuirksFile {
  simHash: string;
  gitCommit: string;
  rows: { id: string; title: string; source: string; legality: string; rules?: { id: string; page?: number | null; pViolation?: number | null }[]; value: { marginDiff: number | null; ci95: number | null; n: number | null; reason?: string }; notes?: string }[];
}
interface LabFile {
  rows: { proposalId: string; intent: string; marginDiffBySeed?: number[] }[];
}

/** Build the archive from parsed results files. Pure, so it can be tested on fixtures. */
export function seedRebuiltArchive(quirks: QuirksFile, lab: LabFile): QuirkArchive {
  const labById = new Map(lab.rows.map((r) => [r.proposalId, r]));
  const archive = new QuirkArchive("rebuilt");
  for (const r of quirks.rows) {
    const l = labById.get(r.id);
    const n = r.value.n ?? 0;
    const bySeed = l?.marginDiffBySeed;
    const reproduced = bySeed ? bySeed.filter((d) => d > 0).length : r.value.marginDiff !== null && r.value.marginDiff > 0 && r.value.ci95 === 0 ? n : 0;
    const node: QuirkNode = {
      id: r.id,
      title: r.title,
      level: "play",
      world: "rebuilt",
      source: r.source,
      start: KNOWN_START[r.id] ?? [],
      end: {},
      effect: { value: r.value.marginDiff, ci95: r.value.ci95, n, unit: UNIT },
      predicted: null,
      legality: (["LEGAL", "RISKY", "ILLEGAL"].includes(r.legality) ? r.legality : "UNJUDGED") as Legality,
      rules: (r.rules ?? []).map((x) => ({ id: x.id, page: x.page ?? null, pViolation: x.pViolation ?? null })),
      reproducibility: { runs: bySeed?.length ?? n, reproduced },
      value: 0,
      notes: [l ? `intent ${l.intent}` : null, r.value.reason ?? null, EXTRA_NOTES[r.id] ?? null, `measured on simHash ${quirks.simHash} (git ${quirks.gitCommit}, engine without G407)`].filter(Boolean).join(". "),
    };
    archive.add(node);
  }
  return archive;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const read = (name: string) => JSON.parse(readFileSync(repoPath("results", name), "utf8"));
  const archive = seedRebuiltArchive(read("quirks.json"), read("lab.json"));
  const file = repoPath("results", "archive.json");
  writeFileSync(file, JSON.stringify(archive.toJSON(), null, 2) + "\n");
  const measured = archive.all().filter((q) => q.effect.value !== null);
  console.log(`[archive] ${archive.size} quirks (${measured.length} measured), ${archive.edges().length} links -> ${file}`);
  for (const q of measured) console.log(`  ${q.id.padEnd(30)} ${String(q.effect.value).padStart(7)} +/- ${q.effect.ci95?.toFixed(1)}  ${q.legality}`);
}
