// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Code PermLang can't check (a package with no adapter, an import with no types) is recorded in
// the lock, so new code of that kind fails the check until it's reviewed (the gate re-verification).

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Report } from "../src/check.js";
import { isUncheckedKey, uncheckedCode, uncheckedEntry, uncheckedWhat } from "../src/unchecked.js";

const root = path.resolve("/repo");
const report = (r: Partial<Report>): Report => ({ files: 1, functions: [], units: [], diagnostics: [], unsafe: [], unmapped: [], unresolved: [], tools: [], ...r });

describe("the entry of code PermLang can't check", () => {
  it("records each package and import once, a file by its path from the lock's folder, where it's first used", () => {
    const at = (file: string) => path.join(root, file);
    const entry = uncheckedEntry(
      report({
        unmapped: [{ package: "leftpad2", calls: 2, file: at("src/app.ts"), line: 7 }],
        unresolved: ["./x.cjs", "left-pad"],
        unresolvedImports: [
          { specifier: "./x.cjs", file: at("src/a/use.ts"), line: 1 },
          { specifier: "./x.cjs", file: at("src/b/use.ts"), line: 2 },
          { specifier: "left-pad", file: at("src/app.ts"), line: 3 },
          { specifier: "left-pad", file: at("src/other.ts"), line: 4 },
        ],
      }),
      at("permlang.config.json"),
      root,
    );
    expect(entry).toMatchObject({ file: at("permlang.config.json"), name: "<unchecked>", kind: "config" });
    expect(entry.actual).toEqual(["unchecked.import(left-pad)", "unchecked.import(src/a/x.cjs)", "unchecked.import(src/b/x.cjs)", "unchecked.package(leftpad2)"]);
    expect(entry.via["unchecked.import(left-pad)"]).toEqual(["src/app.ts:3"]);
    expect(entry.sites["unchecked.package(leftpad2)"]).toEqual({ line: 7, column: 1, file: at("src/app.ts") });
  });

  it("still records the imports of a report that doesn't say where they are", () => {
    expect(uncheckedEntry(report({ unresolved: ["left-pad"] }), path.join(root, "permlang.config.json"), root).actual).toEqual(["unchecked.import(left-pad)"]);
  });

  it("is keyed next to the settings, and describes what it records", () => {
    expect(isUncheckedKey("permlang.config.json#<unchecked>")).toBe(true);
    expect(isUncheckedKey("permlang.config.json#<permlang.config.json>")).toBe(false);
    expect(isUncheckedKey("src/app.ts#unchecked")).toBe(false);
    expect(uncheckedCode("unchecked.import(src/a (1).cjs)")).toEqual({ kind: "import", target: "src/a (1).cjs" });
    expect(uncheckedCode("unchecked.package(@scope/pkg)")).toEqual({ kind: "package", target: "@scope/pkg" });
    expect(uncheckedWhat("unchecked.import(x)")).toBe("an import with no types");
    expect(uncheckedWhat("unchecked.package(x)")).toBe("a package with no adapter");
  });

  // A pull request can write anything in the lock, and an entry only the lock has is named in an error.
  it("reads an entry a hand-edited lock cut short without losing its last character", () => {
    expect(uncheckedCode("unchecked.import(src/x.cjs")).toEqual({ kind: "import", target: "src/x.cjs" });
    expect(uncheckedCode("unchecked.package(leftpad2")).toEqual({ kind: "package", target: "leftpad2" });
  });
});
