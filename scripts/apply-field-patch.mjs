#!/usr/bin/env node
/**
 * node scripts/apply-field-patch.mjs [--dry]
 *
 * Applies games/rebuilt-2026/config-patch.json (official field data gathered by src/field) to
 * config/default.json. Rules:
 *   - a scalar constant (field.lengthM, ...) is replaced by the patch's { value, status, source }
 *   - coordinates inside a grouped constant (field.blueElements.hub.x, field.blueLaneY.left_bump)
 *     are written into that group's value; the group's source then lists, per coordinate, where it
 *     came from, and the group is VERIFIED only if EVERY coordinate in it came straight from an
 *     official document. A group containing derived or placeholder coordinates stays
 *     TODO_VERIFY_AGAINST_MANUAL, with the derivations spelled out in its source.
 *   - paths the config does not have are reported and skipped, never invented.
 */
import { readFileSync, writeFileSync } from "node:fs";

const dry = process.argv.includes("--dry");
const cfgFile = "config/default.json";
const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
const patch = JSON.parse(readFileSync("games/rebuilt-2026/config-patch.json", "utf8"));
const round = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);

const groups = new Map(); // "field.blueElements" -> [{ sub, value, official, source }]
const report = [];
for (const p of patch.patches) {
  const parts = p.path.split(".");
  const [section, key, ...sub] = parts;
  const target = cfg[section]?.[key];
  if (!target || typeof target !== "object" || !("value" in target)) {
    report.push(`SKIP  ${p.path}: no such config constant`);
    continue;
  }
  if (sub.length === 0) {
    report.push(`SET   ${p.path}: ${JSON.stringify(target.value)} -> ${JSON.stringify(round(p.new.value))} (${p.officialStatus})`);
    cfg[section][key] = { value: round(p.new.value), status: p.officialStatus === "official" ? "VERIFIED" : "TODO_VERIFY_AGAINST_MANUAL", source: p.new.source };
    continue;
  }
  let holder = target.value;
  for (const s of sub.slice(0, -1)) holder = holder?.[s];
  const leaf = sub[sub.length - 1];
  if (!holder || typeof holder !== "object" || !(leaf in holder)) {
    report.push(`SKIP  ${p.path}: no such coordinate in the config`);
    continue;
  }
  report.push(`SET   ${p.path}: ${holder[leaf]} -> ${round(p.new.value)} (${p.officialStatus})`);
  holder[leaf] = round(p.new.value);
  const g = `${section}.${key}`;
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push({ sub: sub.join("."), official: p.officialStatus === "official", source: p.new.source });
}

/** Every leaf coordinate path of a grouped value, e.g. "hub.x". */
const leaves = (v, prefix = "") => Object.entries(v).flatMap(([k, x]) => (x && typeof x === "object" ? leaves(x, `${prefix}${k}.`) : [`${prefix}${k}`]));
for (const [g, items] of groups) {
  const [section, key] = g.split(".");
  const target = cfg[section][key];
  const all = leaves(target.value);
  const patched = new Map(items.map((i) => [i.sub, i]));
  const untouched = all.filter((l) => !patched.has(l));
  const allOfficial = untouched.length === 0 && items.every((i) => i.official);
  target.status = allOfficial ? "VERIFIED" : "TODO_VERIFY_AGAINST_MANUAL";
  const short = (s) => s.replace(/\s+/g, " ").slice(0, 260);
  target.source =
    `From official FIRST field data (games/rebuilt-2026/field.json has the full citations). ` +
    items.map((i) => `${i.sub}: ${i.official ? "official" : "DERIVED"}: ${short(i.source)}`).join(" | ") +
    (untouched.length ? ` | STILL A PLACEHOLDER, not found in official data: ${untouched.join(", ")}` : "");
  report.push(`GROUP ${g}: status ${target.status}; ${items.filter((i) => i.official).length} official, ${items.filter((i) => !i.official).length} derived, ${untouched.length} placeholder`);
}

console.log(report.join("\n"));
if (!dry) {
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\nwrote ${cfgFile}`);
}
