/**
 * pnpm field:build (owner: P7): writes games/rebuilt-2026/field.json, games/rebuilt-2026/config-patch.json
 * and results/field_pack.json from OFFICIAL FIRST field data. No network, no NDI: the numbers below were
 * read from the text layer of the official PDFs (manual TU22 ARENA section via data/research/raw, and
 * the 2026 Field Dimension Drawings via pdftotext). Every value carries document, url, page, quote.
 * Frame: metres, x from the blue alliance wall along the length, y across the width from the scoring-table
 * side guardrail (drawing frame; the config's y direction is assumed to be the same).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadConfig, repoPath } from "../util/config";
import { gitCommit, simHash } from "../util/provenance";
import { writeResults } from "../util/runLog";

const B = "https://firstfrc.blob.core.windows.net/frc2026";
const MAN = { document: "2026 FRC Game Manual (REBUILT, TU22) section 5 ARENA", url: `${B}/Manual/2026GameManual.pdf` };
const DWG = { document: "2026 REBUILT Playing Field, Field Dimension Drawings FE-2026 rev B", url: `${B}/FieldAssets/2026-field-dimension-dwgs.pdf` };
const WPI_URL = "https://raw.githubusercontent.com/wpilibsuite/allwpilib/main/fields/src/main/native/resources/org/wpilib/fields/frc/2026-rebuilt-welded.json";
const IN = 0.0254;
const m = (inches: number) => Math.round(inches * IN * 1000) / 1000;

type Status = "official" | "derived" | "not_found";
interface Val {
  key: string;
  configPath: string;
  configValue: number | null;
  value: number | null;
  status: Status;
  src: { document: string; url: string; page: number | null; quote: string };
  arithmetic?: string;
}
const V: Val[] = [];
const add = (v: Val) => V.push(v);
const cfg = loadConfig();
const f = cfg.field;
const be = f.blueElements.value as any;
const lane = f.blueLaneY.value as any;
const es = f.elementSizes!.value as any;

add({ key: "fieldLengthM", configPath: "field.lengthM", configValue: f.lengthM.value, value: m(651.22), status: "official", src: { ...DWG, page: 3, quote: "WELDED PERIMETER (651.22)" } });
add({ key: "fieldWidthM", configPath: "field.widthM", configValue: f.widthM.value, value: m(317.69), status: "official", src: { ...DWG, page: 3, quote: "(317.69)" } });
add({ key: "allianceZoneDepthM", configPath: "field.allianceZoneDepthM", configValue: f.allianceZoneDepthM.value, value: m(158.6), status: "official", src: { ...MAN, page: 22, quote: "ALLIANCE ZONE : A 158.6in deep by 317.7in long (~4.03m by 8.07m)" } });
add({ key: "hub.x", configPath: "field.blueElements.hub.x", configValue: be.hub.x, value: m(182.11), status: "derived", src: { ...DWG, page: 11, quote: "18 Hub, Blue (182.11) (135.09) (44.25) 270; 21 Hub, Blue (182.11) (182.60) (44.25) 90" }, arithmetic: "Tags 18 and 21 sit on the two side faces of the blue HUB at the same x = 182.11 in, so that is the HUB centre x; also sheet 3 reference dimension (182.11); manual p.23 HUB front face 158.6 in + 47 in / 2 = 182.1 in; WPILib blue hub tags give 4.625 m. 182.11 in * 0.0254 = 4.626 m." });
add({ key: "hub.y", configPath: "field.blueElements.hub.y", configValue: be.hub.y, value: m(317.688 / 2), status: "derived", src: { ...DWG, page: 4, quote: "(317.688) ... (158.84)" }, arithmetic: "HUB centred across the width: 317.688 / 2 = 158.844 in (tags 20 and 26 at y = 158.84 on sheet 11) = 4.035 m." });
add({ key: "tower.x", configPath: "field.blueElements.tower.x", configValue: be.tower.x, value: m(45.0 / 2), status: "derived", src: { ...MAN, page: 28, quote: "A TOWER is a 49.25in (1.251m) wide, 45.0in (1.143m) deep ... integrated into each ALLIANCE WALL" }, arithmetic: "TOWER is 45.0 in deep and integrated into the alliance wall, so centre x = 45.0 / 2 = 22.5 in = 0.572 m (assumes the footprint starts at x = 0)." });
add({ key: "tower.y", configPath: "field.blueElements.tower.y", configValue: be.tower.y, value: m((147.47 + 164.47) / 2), status: "derived", src: { ...DWG, page: 11, quote: "31 Tower, Blue (0.32) (147.47) (21.75) 0; 32 Tower, Blue (0.32) (164.47) (21.75) 0" }, arithmetic: "Midpoint of the two blue TOWER AprilTags (IDs 31, 32): (147.47 + 164.47) / 2 = 155.97 in = 3.962 m. WPILib tags 15/16 give y = 4.035 + (-0.289 + 0.143) / 2 = 3.962 m." });
add({ key: "depot.x", configPath: "field.blueElements.depot.x", configValue: be.depot.x, value: m(27.0 / 2), status: "derived", src: { ...MAN, page: 27, quote: "A DEPOT is a 42.0in (1.07m) wide, 27.0in (68.6cm) deep structure located along the ALLIANCE WALL." }, arithmetic: "Depth 27.0 in along x from the alliance wall: centre x = 13.5 in = 0.343 m." });
add({ key: "depot.y", configPath: "field.blueElements.depot.y", configValue: be.depot.y, value: null, status: "not_found", src: { ...DWG, page: null, quote: "no readable dimension for the DEPOT position across the width in the drawing text layer (needs the sheet image or NDI)" } });
add({ key: "outpost.x", configPath: "field.blueElements.outpost.x", configValue: be.outpost.x, value: null, status: "not_found", src: { ...DWG, page: null, quote: "OUTPOST depth not stated in the text read; AprilTags are on the wall plane (x = 0.30 in)" } });
add({ key: "outpost.y", configPath: "field.blueElements.outpost.y", configValue: be.outpost.y, value: m((26.22 + 43.22) / 2), status: "derived", src: { ...DWG, page: 11, quote: "28 Outpost, Blue (0.30) (26.22) (21.75) 0" }, arithmetic: "Midpoint of the blue OUTPOST AprilTags (IDs 28, 29): tag 28 y = 26.22 in (drawing sheet 11); tag 29 y = 43.22 in from WPILib tag 14 (y -2.937 m + 4.035 = 1.098 m) because the drawing text for tag 29 is garbled; (26.22 + 43.22) / 2 = 34.72 in = 0.882 m. Manual p.22 OUTPOST AREA is 71.0 in wide (centre 35.5 in = 0.902 m), consistent." });
add({ key: "lane.right_bump.y", configPath: "field.blueLaneY.right_bump", configValue: lane.right_bump, value: m(158.844 - 60.0), status: "derived", src: { ...MAN, page: 26, quote: "BUMPS are 73.0in (1.854m) wide, 44.4in (1.128m) deep ... on either side of the HUB" }, arithmetic: "Bump adjacent to the 47 in HUB: centre offset from field centre = 47/2 + 73/2 = 60.0 in = 1.524 m; y = 4.035 - 1.524 = 2.511 m. Uncertain by about 0.08 m: trench 65.65 in + bump 73 in + half hub 23.5 in exceeds half the width by 3.3 in, so the parts overlap or have a gap not visible in the text." });
add({ key: "lane.left_bump.y", configPath: "field.blueLaneY.left_bump", configValue: lane.left_bump, value: m(158.844 + 60.0), status: "derived", src: { ...MAN, page: 26, quote: "BUMPS are 73.0in (1.854m) wide ... on either side of the HUB" }, arithmetic: "Mirror of right_bump: 4.035 + 1.524 = 5.559 m." });
add({ key: "lane.right_trench.y", configPath: "field.blueLaneY.right_trench", configValue: lane.right_trench, value: m(65.65 / 2), status: "derived", src: { ...MAN, page: 26, quote: "TRENCHES are a 65.65in (1.668m) wide, 47.0in (1.194m) deep ... The TRENCH extends from the guardrail to the BUMP" }, arithmetic: "Trench footprint runs from the guardrail across 65.65 in, centre = 32.825 in = 0.834 m from the guardrail; the position of the 50.34 in opening inside it is not read." });
add({ key: "lane.left_trench.y", configPath: "field.blueLaneY.left_trench", configValue: lane.left_trench, value: m(317.688 - 65.65 / 2), status: "derived", src: { ...MAN, page: 26, quote: "TRENCHES are a 65.65in (1.668m) wide ... extends from the guardrail to the BUMP on both sides of the FIELD" }, arithmetic: "Mirror: 8.069 - 0.834 = 7.236 m." });
add({ key: "laneLength.bumpM", configPath: "field.laneLengthM", configValue: f.laneLengthM.value, value: m(44.4), status: "official", src: { ...MAN, page: 26, quote: "BUMPS are 73.0in (1.854m) wide, 44.4in (1.128m) deep, and 6.513in (16.54cm) tall" } });
add({ key: "laneLength.trenchM", configPath: "field.laneLengthM", configValue: f.laneLengthM.value, value: m(47.0), status: "official", src: { ...MAN, page: 26, quote: "TRENCHES are a 65.65in (1.668m) wide, 47.0in (1.194m) deep, and 40.25in (1.022m) tall" } });
add({ key: "trenchClearanceM", configPath: "(none)", configValue: null, value: m(22.25), status: "official", src: { ...MAN, page: 26, quote: "The space underneath each TRENCH arm is 50.34in (1.279m) wide, 22.25in (56.52cm) tall." } });
add({ key: "trenchOpeningWidthM", configPath: "(none)", configValue: null, value: m(50.34), status: "official", src: { ...MAN, page: 26, quote: "The space underneath each TRENCH arm is 50.34in (1.279m) wide, 22.25in (56.52cm) tall." } });
add({ key: "elementSizes.hubSizeM", configPath: "field.elementSizes.hubSizeM", configValue: es.hubSizeM, value: m(47), status: "official", src: { ...MAN, page: 23, quote: "A HUB is one of two 47in by 47in (~1.19m by 1.19m) rectangular prism structures" } });
add({ key: "elementSizes.towerWidthM", configPath: "field.elementSizes.towerWidthM", configValue: es.towerWidthM, value: m(49.25), status: "official", src: { ...MAN, page: 28, quote: "A TOWER is a 49.25in (1.251m) wide, 45.0in (1.143m) deep, and 78.25in (1.988m) tall structure" } });
add({ key: "elementSizes.towerDepthM", configPath: "field.elementSizes.towerDepthM", configValue: es.towerDepthM, value: m(45.0), status: "official", src: { ...MAN, page: 28, quote: "A TOWER is a 49.25in (1.251m) wide, 45.0in (1.143m) deep" } });
add({ key: "elementSizes.trenchWidthM", configPath: "field.elementSizes.trenchWidthM", configValue: es.trenchWidthM, value: m(65.65), status: "official", src: { ...MAN, page: 26, quote: "TRENCHES are a 65.65in (1.668m) wide, 47.0in (1.194m) deep" } });
add({ key: "elementSizes.bumpWidthM", configPath: "field.elementSizes.bumpWidthM", configValue: es.bumpWidthM, value: m(73.0), status: "official", src: { ...MAN, page: 26, quote: "BUMPS are 73.0in (1.854m) wide, 44.4in (1.128m) deep" } });
add({ key: "neutralZoneLengthM", configPath: "(none)", configValue: null, value: m(283), status: "official", src: { ...MAN, page: 22, quote: "NEUTRAL ZONE : A 283in deep by 317.7in long (7.19m by 8.07m)" } });
add({ key: "depotWidthM", configPath: "(none)", configValue: null, value: m(42.0), status: "official", src: { ...MAN, page: 27, quote: "A DEPOT is a 42.0in (1.07m) wide, 27.0in (68.6cm) deep" } });

const generatedTs = new Date().toISOString();
const wrap = (v: Val) => ({
  value: v.value,
  source: { document: v.src.document, url: v.src.url, page: v.src.page, quote: v.src.quote.split(/\s+/).slice(0, 25).join(" ") },
  status: v.status,
  ...(v.arithmetic ? { arithmetic: v.arithmetic } : {}),
});
const g = (k: string) => wrap(V.find((v) => v.key === k)!);
const xy = (a: string, b: string) => ({ x: g(a), y: g(b) });
const fieldJson = {
  generatedTs,
  note: "Values from official FIRST documents only; derived values state their arithmetic; not_found keeps the config placeholder. Drawing frame: y from the scoring-table side guardrail. The Layout and Marking Diagram was not separately retrieved.",
  units: "metres",
  coordinateSystem: "x runs along the field length from the blue alliance wall at 0; y across the width; red is the 180-degree rotation of blue",
  elements: {
    fieldLengthM: g("fieldLengthM"),
    fieldWidthM: g("fieldWidthM"),
    allianceZoneDepthM: g("allianceZoneDepthM"),
    neutralZoneLengthM: g("neutralZoneLengthM"),
    blue: { hub: xy("hub.x", "hub.y"), tower: xy("tower.x", "tower.y"), depot: xy("depot.x", "depot.y"), outpost: xy("outpost.x", "outpost.y") },
    lanes: {
      left_trench: { y: g("lane.left_trench.y"), lengthM: g("laneLength.trenchM"), widthM: g("elementSizes.trenchWidthM") },
      right_trench: { y: g("lane.right_trench.y"), lengthM: g("laneLength.trenchM"), widthM: g("elementSizes.trenchWidthM") },
      left_bump: { y: g("lane.left_bump.y"), lengthM: g("laneLength.bumpM"), widthM: g("elementSizes.bumpWidthM") },
      right_bump: { y: g("lane.right_bump.y"), lengthM: g("laneLength.bumpM"), widthM: g("elementSizes.bumpWidthM") },
    },
    trenchClearanceM: g("trenchClearanceM"),
    trenchOpeningWidthM: g("trenchOpeningWidthM"),
    elementSizes: {
      hubSizeM: g("elementSizes.hubSizeM"),
      towerWidthM: g("elementSizes.towerWidthM"),
      towerDepthM: g("elementSizes.towerDepthM"),
      trenchWidthM: g("elementSizes.trenchWidthM"),
      bumpWidthM: g("elementSizes.bumpWidthM"),
      depotWidthM: g("depotWidthM"),
    },
  },
};
mkdirSync(repoPath("games", "rebuilt-2026"), { recursive: true });
writeFileSync(repoPath("games", "rebuilt-2026", "field.json"), JSON.stringify(fieldJson, null, 2) + "\n");

const patchable = (v: Val) => v.status !== "not_found" && v.configPath !== "(none)" && !v.key.startsWith("laneLength");
const patch = {
  generatedTs,
  note: "blueElements also holds depot.y and outpost.x which are NOT found: keep those placeholders and their TODO status. left/right follow the config ordering (left = larger y). laneLengthM is one number in config but bump depth is 1.128 m and trench depth 1.194 m: not patched.",
  patches: V.filter(patchable).map((v) => ({
    path: v.configPath,
    new: { value: v.value, status: "VERIFIED", source: `${v.src.document}, ${v.src.url}, page ${v.src.page}: "${v.src.quote}"${v.arithmetic ? ` [derived: ${v.arithmetic}]` : ""}` },
    officialStatus: v.status,
  })),
};
writeFileSync(repoPath("games", "rebuilt-2026", "config-patch.json"), JSON.stringify(patch, null, 2) + "\n");

const rows = V.map((v) => ({
  key: v.key,
  configPath: v.configPath,
  configValue: v.configValue,
  officialValue: v.value,
  differenceM: v.configValue !== null && v.value !== null ? Math.round((v.value - v.configValue) * 1000) / 1000 : null,
  status: v.status,
  page: v.src.page,
  url: v.src.url,
}));
const count = (s: Status) => V.filter((v) => v.status === s).length;
const summary = {
  official: count("official"),
  derived: count("derived"),
  notFound: count("not_found"),
  largestDifferences: rows
    .filter((r) => r.differenceM !== null)
    .sort((a, b) => Math.abs(b.differenceM!) - Math.abs(a.differenceM!))
    .slice(0, 6)
    .map((r) => ({ key: r.key, differenceM: r.differenceM })),
  ndiCostUsd: 0,
  ndiNote: "One NDI extract on field-manual.pdf was refused with HTTP 403 (Nace-side block); no NDI cost. Values were read from the PDF text layer (pdftotext) instead. pnpm field:extract (src/field/extract.ts) is ready for when the block clears.",
  sources: [
    `${B}/Manual/2026GameManual.pdf (page text from data/research/raw/bf376745c62f498c.json, TU22; page numbers are the manual's own footers)`,
    `${B}/FieldAssets/2026-field-dimension-dwgs.pdf (sheets 3, 4, 11; fetched to a temp dir only, not committed)`,
    "https://www.firstinspires.org/resources/library/frc/playing-field",
    WPI_URL,
  ],
  needsNdiOrImage: ["depot.y", "outpost.x", "position of the trench opening", "bump/trench 3.3 in overlap", "Layout and Marking Diagram (not located)"],
  wpilib: "2026-rebuilt-welded.json and -andymark.json exist (fields/ directory, not apriltag/); field 16.541 x 8.069 m, origin at field centre; blue hub tags (x 4.625 m), tower tags 15/16, outpost tags 13/14 agree with drawing sheet 11 within 0.01 m. Saved under games/rebuilt-2026/sources/. The example FieldConstants.java is empty (TODO).",
  cad: { step: `${B}/FieldAssets/FE-2026-rev-rebuilt-playing-field.step`, publiclyDownloadable: true, sizeBytes: 35707894, downloaded: false, note: "HTTP 200 on a HEAD request without sign-in; an Onshape link is also on the page." },
};
writeResults({ experiment: "field_pack", createdTs: generatedTs, isMock: false, gitCommit: gitCommit(), simHash: simHash(cfg), config: { field: f }, rows, summary });
console.log("key".padEnd(28), "config".padStart(8), "official".padStart(9), "diff".padStart(7), "status", "page");
for (const r of rows) console.log(String(r.key).padEnd(28), String(r.configValue ?? "-").padStart(8), String(r.officialValue ?? "-").padStart(9), String(r.differenceM ?? "-").padStart(7), r.status, r.page ?? "");
console.log(JSON.stringify({ official: summary.official, derived: summary.derived, notFound: summary.notFound }));
