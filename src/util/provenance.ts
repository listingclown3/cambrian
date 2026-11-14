/**
 * Run provenance: git commit and sim hash (shared utility; Node only).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "../contracts";
import { REPO_ROOT } from "./config";

/** Current git commit, with "-dirty" appended when the tree has changes; "uncommitted" outside a repo. */
export function gitCommit(): string {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const head = run(["rev-parse", "--short=12", "HEAD"]);
    return run(["status", "--porcelain"]) === "" ? head : `${head}-dirty`;
  } catch {
    return "uncommitted";
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Hash of everything that determines simulation behaviour: the source of src/contracts,
 * src/engine and src/exec (tests excluded) plus the config. Two results are comparable only if
 * their sim hashes match.
 */
export function simHash(cfg: Config): string {
  const hash = createHash("sha256");
  for (const dir of ["src/contracts", "src/engine", "src/exec"]) {
    for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
      hash.update(path.relative(REPO_ROOT, file).replaceAll("\\", "/"));
      hash.update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
    }
  }
  hash.update(JSON.stringify(cfg));
  return hash.digest("hex").slice(0, 16);
}
