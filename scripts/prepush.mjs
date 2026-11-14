#!/usr/bin/env node
/**
 * pnpm prepush: secret scan. Run before EVERY push; the repo is public.
 *
 * Fails (exit 1) on any hit in:
 *   1. every file git would publish (tracked, plus untracked files that are not ignored)
 *   2. every line ever added in the commit history (high-confidence key patterns only)
 * Also fails if .env is tracked or not ignored. Runs gitleaks too when it is installed.
 *
 * Values are never printed: a hit shows the file, line number and rule only.
 * To allow a deliberate false positive, put `secret-scan:allow` on the same line.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Key formats we know. Checked in files and in history. */
const KEY_RULES = [
  ["nace key", /nace_sk_[A-Za-z0-9_-]{20,}/],
  ["keenable key", /keen_[a-z0-9]{6,}_[a-f0-9]{32,}/],
  ["sk- style key (DeepInfra, OpenAI, Anthropic)", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
  ["google api key", /AIza[A-Za-z0-9_-]{30,}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Looser rules. Checked in current files only. */
const LOOSE_RULES = [
  ["assigned secret (API_KEY / TOKEN / SECRET / PASSWORD = value)", /[A-Za-z_]*(API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*["']?\s*[=:]\s*["']?[A-Za-z0-9_\-+/]{12,}/],
  // 40+ characters mixing lower case, upper case and digits. "/" is not part of the run, so URL
  // and file paths (many short segments) do not match; a single 40+ character segment still does.
  ["long base64-like string", /(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[0-9])[A-Za-z0-9+_-]{40,}={0,2}/],
];

/** Files whose contents are hashes or binary by nature. */
const SKIP_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$|\.(gif|png|jpg|jpeg|webp|ico|pdf|woff2?)$/i;

const hits = [];
const check = (where, line, text, rules) => {
  if (text.includes("secret-scan:allow")) return;
  for (const [name, re] of rules) if (re.test(text)) hits.push(`${where}:${line}  ${name}`);
};

// 0. .env must be ignored and untracked.
if (git("ls-files", ".env").trim() !== "") hits.push(".env  is tracked by git");
if (spawnSync("git", ["check-ignore", "-q", ".env"]).status !== 0) hits.push(".env  is not gitignored");

// 1. Everything git would publish.
const files = git("ls-files", "-co", "--exclude-standard", "-z").split("\0").filter(Boolean);
for (const file of files) {
  if (SKIP_FILE.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  text.split("\n").forEach((line, i) => check(file, i + 1, line, [...KEY_RULES, ...LOOSE_RULES]));
}

// 2. Every line ever added in history.
let commit = "";
let file = "";
for (const line of git("log", "--all", "-p", "--no-color", "--unified=0", "--format=commit %h").split("\n")) {
  if (line.startsWith("commit ")) commit = line.slice(7);
  else if (line.startsWith("+++ b/")) file = line.slice(6);
  else if (line.startsWith("+") && !SKIP_FILE.test(file)) check(`history ${commit} ${file}`, "+", line, KEY_RULES);
}

// 3. gitleaks, when installed.
const gitleaks = spawnSync("gitleaks", ["detect", "--no-banner", "--redact", "--source", "."], { encoding: "utf8" });
if (gitleaks.error) console.log("gitleaks not installed; used the built-in scan only.");
else if (gitleaks.status !== 0) hits.push(`gitleaks  reported leaks:\n${gitleaks.stdout}${gitleaks.stderr}`);
else console.log("gitleaks: no leaks.");

if (hits.length > 0) {
  console.error(`\nSECRET SCAN FAILED: ${hits.length} hit(s). Do not push.\n`);
  for (const hit of [...new Set(hits)]) console.error(`  ${hit}`);
  console.error("\nRemove the secret, rotate the key if it was ever committed, then run pnpm prepush again.");
  process.exit(1);
}
console.log(`secret scan passed: ${files.length} files and the full history are clean. Safe to push.`);
