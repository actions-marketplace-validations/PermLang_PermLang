// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Building a ts-morph project with @types/node takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Separate processes, not threads: test/run-cli.ts changes directory, which threads can't.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The two-line entry point; test/cli.test.ts runs it as a real process, which coverage can't see.
      exclude: ["src/cli.ts"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
