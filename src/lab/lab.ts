/**
 * pnpm lab (owner: P3): the Strategy Lab.
 *
 * System 2 (a large model on DeepInfra) runs inside Intern, supervised by System 1 (Drex). It
 * reads the research and proposes strategies; the simulator then tests each one.
 *
 * STUB. Steps for P3:
 *   1. Build cfg.lab.workspaceDir containing ONLY copies of data/research/notes.json,
 *      data/rules/rules.json, results/scenarios.json (when present), plus a generated SYSTEM2.md
 *      (task rules) and AGENTS.md (output contract: the ProposalsFile JSON shape).
 *      Intern is not a sandbox: never hand it the repo root or .env; use its Docker workspace if
 *      available.
 *   2. Run `intern -p --json --system2 <provider>/<model> -- "TASK"` as a subprocess with
 *      cwd = the workspace. Run `intern schema` once and type the JSON event stream from it.
 *   3. Read lab/workspace/proposals.json and validate with parseProposals() below. Treat the file
 *      as untrusted data: reject anything that does not match the contract.
 *   4. Copy valid proposals to data/lab/proposals.json; simulate each (answer-key rollouts on the
 *      relevant families, full matches vs the scripted baseline on eval seeds); write
 *      results/lab.json with LabResultRow rows.
 *   5. recordUsage(cfg, { tool: "intern", purpose: "strategy_lab", counts: { sessions: 1,
 *      system1Judgments, turns }, ... }) for every session.
 */
import { pathToFileURL } from "node:url";
import { ProposalSchema, MAX_LAB_PROPOSALS, type Proposal } from "../contracts";
import { notImplementedYet } from "../util/stub";

/**
 * Validate proposals written by Intern. Returns the valid ones (at most MAX_LAB_PROPOSALS, first
 * come first kept, duplicate ids dropped) and a reason for each one rejected.
 */
export function parseProposals(raw: unknown): { accepted: Proposal[]; rejected: { index: number; reason: string }[] } {
  const accepted: Proposal[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const list = raw && typeof raw === "object" && Array.isArray((raw as { proposals?: unknown }).proposals) ? (raw as { proposals: unknown[] }).proposals : null;
  if (list === null) return { accepted, rejected: [{ index: -1, reason: "expected an object with a `proposals` array" }] };
  list.forEach((item, index) => {
    const parsed = ProposalSchema.safeParse(item);
    if (!parsed.success) rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else if (accepted.some((p) => p.id === parsed.data.id)) rejected.push({ index, reason: `duplicate id ${parsed.data.id}` });
    else if (accepted.length >= MAX_LAB_PROPOSALS) rejected.push({ index, reason: `more than ${MAX_LAB_PROPOSALS} proposals` });
    else accepted.push(parsed.data);
  });
  return { accepted, rejected };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  notImplementedYet(
    "lab",
    "Run Intern (System 2 on DeepInfra, supervised by Drex) over the research to propose up to 5 strategies, validate them, and test each in the simulator.",
    ["data/research/notes.json", "data/rules/rules.json", "results/scenarios.json"],
    ["lab/workspace/proposals.json", "data/lab/proposals.json", "results/lab.json"],
  );
}
