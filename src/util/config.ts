/**
 * Config loading (shared utility; Node only).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type Config } from "../contracts";

/** Absolute path of the repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Absolute path of a file given relative to the repository root. */
export function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

/** Load and validate a config file (default: config/default.json). Throws on any schema violation. */
export function loadConfig(file: string = repoPath("config", "default.json")): Config {
  return ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Every game/field constant still marked TODO_VERIFY_AGAINST_MANUAL, as dotted paths. */
export function listUnverified(cfg: Config): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  for (const section of ["game", "field"] as const) {
    for (const [key, entry] of Object.entries(cfg[section])) {
      if (entry && typeof entry === "object" && "status" in entry && entry.status === "TODO_VERIFY_AGAINST_MANUAL") {
        out.push({ path: `${section}.${key}`, source: entry.source });
      }
    }
  }
  return out;
}
