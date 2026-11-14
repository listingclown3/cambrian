#!/usr/bin/env node
/**
 * pnpm ci:status: one line per agent branch for the integrator: commits not yet on main, the
 * newest commit, and whether its worktree has uncommitted work. Read-only.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const git = (cwd, ...args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const here = process.cwd();
const now = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
console.log(`ci status at ${now}; main is ${git(here, "log", "-1", "--format=%h %s").slice(0, 70)}`);
for (const branch of git(here, "branch", "--format=%(refname:short)").split("\n").filter((b) => /^p\d+$/.test(b))) {
  const ahead = git(here, "rev-list", "--count", `main..${branch}`) || "0";
  const behind = git(here, "rev-list", "--count", `${branch}..main`) || "0";
  const last = git(here, "log", "-1", "--format=%h %ad %s", "--date=format-local:%H:%M", branch).slice(0, 84);
  const tree = path.join(path.dirname(here), `cambrian-${branch}`);
  const dirty = existsSync(tree) ? git(tree, "status", "--short").split("\n").filter(Boolean).length : "?";
  console.log(`${branch}: ${ahead} to merge, ${behind} behind main, ${dirty} uncommitted | ${last}`);
}
