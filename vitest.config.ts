import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "experiments/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
