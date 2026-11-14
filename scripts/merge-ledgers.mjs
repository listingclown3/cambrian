#!/usr/bin/env node
/**
 * pnpm ledger:merge: fold the usage ledgers of sibling worktrees into this one.
 *
 * Each worktree (../cambrian-p1, -p2, ...) records its own real calls in its own gitignored
 * runs/usage.jsonl. The headline's usage numbers come from the main worktree's ledger, so the
 * integrator runs this before `pnpm usage` / `pnpm headline`. Lines are de-duplicated exactly,
 * so running it repeatedly never double-counts.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const here = process.cwd();
const mainLedger = path.join(here, "runs", "usage.jsonl");
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "") : []);

const lines = read(mainLedger);
const seen = new Set(lines);
const parent = path.dirname(here);
let added = 0;
for (const dir of readdirSync(parent).filter((d) => /^cambrian-p\d+$/.test(d)).sort()) {
  let fromHere = 0;
  for (const line of read(path.join(parent, dir, "runs", "usage.jsonl"))) {
    if (seen.has(line)) continue;
    try {
      JSON.parse(line);
    } catch {
      continue; // a partially written line; picked up on the next run
    }
    seen.add(line);
    lines.push(line);
    fromHere += 1;
  }
  console.log(`${dir}: ${fromHere} new entries`);
  added += fromHere;
}
lines.sort((a, b) => (JSON.parse(a).ts < JSON.parse(b).ts ? -1 : 1));
mkdirSync(path.dirname(mainLedger), { recursive: true });
writeFileSync(mainLedger, lines.join("\n") + "\n");
console.log(`ledger: ${lines.length} entries (${added} added)`);
