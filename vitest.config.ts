import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Building a ts-morph project with @types/node takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The CLI is tested by running it (test/cli.test.ts), in a child process coverage can't see.
      exclude: ["src/cli.ts"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
