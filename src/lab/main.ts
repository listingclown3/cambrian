/** Entry for `pnpm lab`: the full lab run, or `-- --trial` for the one-file Intern trial in lab.ts. */
import path from "node:path";
import { loadConfig } from "../util/config";

if (process.argv.includes("--trial")) {
  process.argv[1] = path.join(import.meta.dirname, "lab.ts"); // lab.ts runs its trial when it is the entry file
  await import("./lab");
} else {
  const { runLab } = await import("./labRun");
  await runLab(loadConfig());
}
