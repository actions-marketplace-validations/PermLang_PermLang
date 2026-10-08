// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Strictness levels (design doc §7), set in permlang.config.json:
//   sketch       permissions are inferred and reported; annotation rules don't fail
//   development  exported functions and entry points must declare what they reach
//   production   every function must be covered by function- or module-level @perm
// A stale lock, flow rules, and "error" policies fail at every level.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type Strictness } from "../src/check.js";

const app = fileURLToPath(new URL("./strictness-fixtures/app.ts", import.meta.url));

function summary(strictness: Strictness | undefined): string[] {
  const report = checkFiles([app], strictness ? { strictness } : {});
  return report.diagnostics.map((d) => `${d.severity} ${d.code} ${d.function}`).sort();
}

describe("strictness levels", () => {
  it("sketch reports everything and fails nothing", () => {
    expect(summary("sketch")).toEqual([
      "warning PERM001 annotated",
      "warning PERM002 badAnnotation",
      "warning PERM003 unannotated",
    ]);
  });

  it("development requires exported functions to declare what they reach", () => {
    expect(summary("development")).toEqual([
      "error PERM001 annotated",
      "error PERM002 badAnnotation",
      "error PERM003 unannotated",
    ]);
  });

  it("production also requires private helpers to be covered", () => {
    expect(summary("production")).toEqual([
      "error PERM001 annotated",
      "error PERM002 badAnnotation",
      "error PERM003 helper",
      "error PERM003 unannotated",
    ]);
  });

  it("defaults to development", () => {
    expect(summary(undefined)).toEqual(summary("development"));
  });

  it("relaxes only the annotation rules at sketch: a flow rule, asked for explicitly, still fails", () => {
    const explicit = fileURLToPath(new URL("./strictness-fixtures/explicit.ts", import.meta.url));
    const flows = [{ from: { name: "env", arg: "TOKEN" }, to: [{ name: "net", arg: "api.example.com" }] }];
    const at = (strictness: Strictness) =>
      checkFiles([explicit], { strictness, flows }).diagnostics.map((d) => `${d.severity} ${d.code} ${d.function}`).sort();
    expect(at("sketch")).toEqual(["error PERM009 leaks", "warning PERM004 runs"]);
    expect(at("development")).toEqual(["error PERM004 runs", "error PERM009 leaks"]);
  });
});
