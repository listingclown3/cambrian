import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Ports come from config/default.json so the server and the dev client always agree.
const cfg = JSON.parse(readFileSync(new URL("../config/default.json", import.meta.url), "utf8"));
const api = `http://127.0.0.1:${Number(process.env.CAMBRIAN_PORT ?? cfg.server.port)}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.CAMBRIAN_WEB_PORT ?? cfg.server.webDevPort),
    strictPort: true,
    proxy: {
      "/api": api,
      "/ws": { target: api, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
