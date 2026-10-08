// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // Fixtures are inputs for the checker, written to look like real (often bad) code.
    ignores: ["dist/", "coverage/", "fixtures/", "test/*-fixtures/", "node_modules/"],
  },
  // A rule switched off for a line says why; one that no longer needs switching off fails.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ["*.config.ts", "*.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // PermLang matches control characters on purpose, to escape or reject them.
      "no-control-regex": "off",
      // An invisible character looks like nothing in a review: write it as an escape instead.
      "no-irregular-whitespace": ["error", { skipStrings: false, skipComments: false, skipRegExps: false, skipTemplates: false }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Tests read JSON output, and Vitest's matchers (expect.stringMatching and friends) are typed any.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Some tests throw values that aren't Errors on purpose, as a bug in PermLang might.
      "@typescript-eslint/only-throw-error": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
