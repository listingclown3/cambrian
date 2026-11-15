/**
 * pnpm world:field-extract (owner: P7): NDI extract of field dimensions from one official FIRST document.
 * Usage: tsx src/world/worlds/rebuilt/field/extract.ts <cacheKey> <url> <file_name> [page_ranges]
 * Saves the finished job in cache/ndi/<cacheKey>.json and prints each field with page and quote.
 */
import "dotenv/config";
import { ndiJob } from "../../../../history/ingest/ndiClient";
import { loadConfig } from "../../../../util/config";

const HOSTS = ["firstinspires.org", "firstfrc.blob.core.windows.net"];
export const FIELDS: Record<string, string> = {
  field_length_in: "Overall field length in inches, alliance wall to alliance wall.",
  field_width_in: "Overall field width in inches, guardrail to guardrail.",
  alliance_zone_depth_in: "Depth of the alliance zone in inches, from the alliance wall to the alliance zone line.",
  neutral_zone_length_in: "Length of the neutral zone in inches (along the field length).",
  hub_center_distance_from_alliance_wall_in: "Distance in inches from the alliance wall to the center of that alliance's HUB.",
  hub_center_distance_from_side_wall_in: "Distance in inches from the side guardrail to the center of the HUB.",
  hub_width_in: "Width (one side of the square footprint) of the HUB in inches.",
  tower_distance_from_alliance_wall_in: "Distance in inches from the alliance wall to the TOWER (upright or base).",
  tower_distance_from_side_wall_in: "Distance in inches from the side guardrail to the TOWER.",
  tower_width_in: "Width of the TOWER base in inches.",
  tower_depth_in: "Depth of the TOWER base in inches.",
  depot_position: "Where the DEPOT is: distance from the alliance wall and from the side wall in inches, as text.",
  depot_width_in: "Depot width in inches.",
  depot_depth_in: "Depot depth in inches.",
  outpost_position: "Where the OUTPOST is: distance from the side wall in inches, as text.",
  outpost_width_in: "Outpost width in inches.",
  trench_opening_width_in: "Width of the opening of a TRENCH in inches (along the field length).",
  trench_clearance_height_in: "Clearance height of the TRENCH opening in inches.",
  trench_distance_from_side_wall_in: "Distance in inches from the side guardrail to the near edge or center of the TRENCH.",
  trench_length_in: "Length of the TRENCH along the field length in inches.",
  bump_width_in: "Width of a BUMP in inches, across the field width.",
  bump_length_in: "Length of a BUMP in inches, along the field length.",
  bump_height_in: "Height of a BUMP in inches.",
  bump_distance_from_side_wall_in: "Distance in inches from the side guardrail to the BUMP.",
  hub_distance_from_neutral_zone_center_in: "Distance in inches from the field center line to the HUB center.",
};

const [, , cacheKey, url, fileName, pageRanges] = process.argv;
if (!cacheKey || !url) { console.error("usage: extract.ts cacheKey url file_name [page_ranges]"); process.exit(1); }
const host = new URL(url).hostname;
if (!HOSTS.includes(host)) { console.error(`host ${host} not allowed`); process.exit(1); }
const cfg = loadConfig();
const body: Record<string, unknown> = {
  source: { type: "url", url, file_name: fileName ?? "doc.pdf" },
  schema: { type: "object", properties: Object.fromEntries(Object.entries(FIELDS).map(([k, d]) => [k, { type: k.endsWith("_position") ? "string" : "number", description: d }])) },
  instructions: "This is an official FIRST Robotics Competition 2026 REBUILT field document. Use only values the document states or dimensions explicitly. Leave a field empty when it is not stated.",
  citations: { enabled: true, include_source_text: true },
};
if (pageRanges) body.page_ranges = pageRanges;
const job = await ndiJob(cfg, "extract", body, { purpose: "field_extract", cacheKey });
console.log(job.status, "cost", job.cost?.total_usd, JSON.stringify(job.cost?.lines ?? []));
for (const f of job.result?.fields ?? []) {
  const c = f.citations?.[0];
  console.log(f.path, f.status, JSON.stringify(f.value), "p", JSON.stringify(c?.location?.page ?? c?.location), "|", String(c?.source_text ?? "").replace(/\s+/g, " ").slice(0, 120));
}
if (job.status !== "succeeded") console.log(JSON.stringify(job.error ?? {}).slice(0, 400));
