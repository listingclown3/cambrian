#!/usr/bin/env node
/**
 * pnpm describe: fill the judges' description from recorded results.
 *
 * Reads description.txt (the template, with {{headline_key}} placeholders) and
 * results/headline.json, and writes description.filled.txt. A placeholder is replaced only when
 * its number exists; anything not measured yet is left as {{key}} and listed, so an unfilled or
 * invented number can never slip into the submission. Run `pnpm headline` first.
 */
import { readFileSync, writeFileSync } from "node:fs";

const template = readFileSync("description.txt", "utf8");
const headline = JSON.parse(readFileSync("results/headline.json", "utf8")).summary;

/** Format one headline value for prose. */
function format(key, value) {
  if (typeof value !== "number") return String(value);
  if (/^(top1_|context_sensitivity_)/.test(key)) return `${Math.round(value * 100)}%`;
  if (/_pct/.test(key)) return String(Math.round(value));
  if (/_ms$/.test(key)) return value < 10 ? value.toFixed(1) : String(Math.round(value));
  if (/^latency_ratio/.test(key)) return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  if (/cost_per_1k_usd$/.test(key)) return value === 0 ? "0" : Number(value.toPrecision(2)).toString();
  if (/^live_margin/.test(key)) return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
  if (/^(regret_|rollouts_to_best|matches_per_sec)/.test(key)) return value.toFixed(1);
  return Math.round(value).toLocaleString("en-US");
}

const filled = [];
const missing = [];
const unknown = [];
const text = template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (whole, key) => {
  if (!(key in headline)) {
    unknown.push(key);
    return whole;
  }
  if (headline[key] === null) {
    missing.push(key);
    return whole;
  }
  filled.push(key);
  return format(key, headline[key]);
});

writeFileSync("description.filled.txt", text);
console.log(`filled ${filled.length} of ${filled.length + missing.length + unknown.length} placeholders -> description.filled.txt`);
for (const key of filled) console.log(`  ${key} = ${format(key, headline[key])}`);
if (missing.length) console.log(`\nNOT MEASURED YET (left as {{...}}; do not submit until these are filled):\n  ${[...new Set(missing)].join("\n  ")}`);
if (unknown.length) console.log(`\nNOT A HEADLINE KEY (check the spelling):\n  ${[...new Set(unknown)].join("\n  ")}`);
console.log(`\nall_real: ${headline.all_real}`);
process.exit(unknown.length ? 1 : 0);
