/**
 * pnpm start / pnpm dev:server (owner: P4): one Node process serving the API, the demo socket,
 * and (when built) the web client.
 */
import "dotenv/config";
import { ENGINE_IS_STUB } from "../engine";
import { listUnverified, loadConfig } from "../util/config";
import { buildApp } from "./app";

const cfg = loadConfig();
const app = await buildApp(cfg);
await app.listen({ port: cfg.server.port, host: "127.0.0.1" });

console.log(`server:  http://127.0.0.1:${cfg.server.port}  (api: /api/health, socket: /ws/demo)`);
console.log(`web dev: http://127.0.0.1:${cfg.server.webDevPort}  (when started with pnpm dev)`);
if (ENGINE_IS_STUB) console.log("note:    the engine is the STUB; nothing it produces is a result.");
const todo = listUnverified(cfg);
if (todo.length > 0) console.log(`note:    ${todo.length} game/field constants are still TODO_VERIFY_AGAINST_MANUAL.`);
