import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/support/globalSetup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The suites share one Phoenix server and its control state.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        "src/core/**": {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        branches: 95,
        lines: 95,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "core",
          environment: "node",
          include: ["test/core/**/*.test.ts"],
          setupFiles: ["test/support/sockets.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "apollo4",
          environment: "jsdom",
          include: ["test/apollo4/**/*.test.{ts,tsx}"],
          setupFiles: ["test/support/sockets.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "apollo3",
          environment: "jsdom",
          include: ["test/apollo3/**/*.test.{ts,tsx}"],
          setupFiles: ["test/support/sockets.ts"],
        },
      },
    ],
  },
});
