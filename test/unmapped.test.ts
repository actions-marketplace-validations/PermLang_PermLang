// Packages with no adapter are trusted: PermLang can't see what they touch
// (design doc decision D1). The trial showed this is the largest gap in practice,
// so every such package is listed in the report and, by default, warned about.
// Packages known to touch nothing are declared pure in adapters/pure.json.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type CheckOptions } from "../src/check.js";

const dir = fileURLToPath(new URL("./unmapped-fixtures/", import.meta.url));
const files = [path.join(dir, "app.ts"), path.join(dir, "types.d.ts")];
const run = (options: CheckOptions = {}) => checkFiles(files, options);

describe("packages without adapters", () => {
  it("lists each one with its call count and first call site", () => {
    expect(run().unmapped).toEqual([
      { package: "mystery-sdk", calls: 4, file: expect.stringMatching(/app\.ts$/), line: 6 },
    ]);
  });

  it("warns once per package by default", () => {
    const d = run().diagnostics.filter((x) => x.code === "PERM006");
    expect(d).toEqual([
      expect.objectContaining({
        severity: "warning",
        capability: "mystery-sdk",
        line: 6,
        message: expect.stringMatching(/^notify calls into mystery-sdk \(4 calls in 1 file\), which has no adapter/),
      }),
    ]);
  });

  it("can fail the build, or stay quiet", () => {
    expect(run({ unmapped: "error" }).diagnostics.filter((x) => x.code === "PERM006").map((x) => x.severity)).toEqual(["error"]);
    expect(run({ unmapped: "trust" }).diagnostics.filter((x) => x.code === "PERM006")).toEqual([]);
    // The report lists them either way.
    expect(run({ unmapped: "trust" }).unmapped).toHaveLength(1);
  });

  // Found in review: sketch, which init sets up, turned an explicit "error" into a warning.
  it("keeps an explicit error policy at sketch, and warns by default", () => {
    expect(run({ unmapped: "error", strictness: "sketch" }).diagnostics.filter((x) => x.code === "PERM006").map((x) => x.severity)).toEqual(["error"]);
    expect(run({ strictness: "sketch" }).diagnostics.filter((x) => x.code === "PERM006").map((x) => x.severity)).toEqual(["warning"]);
  });

  it("doesn't count packages declared pure", () => {
    expect(run().unmapped.map((u) => u.package)).not.toContain("zod");
  });
});

describe("imports whose types can't be found", () => {
  const unresolvedFile = path.join(dir, "unresolved.ts");
  const report = (options: CheckOptions = {}) => checkFiles([unresolvedFile], options);

  it("reports each one, since nothing called from it can be checked", () => {
    const d = report().diagnostics.filter((x) => x.code === "PERM007");
    expect(d.map((x) => `${x.severity} ${x.capability} ${x.line}`)).toEqual([
      "warning node:child_process-missing-types 3",
      "warning no-such-package 4",
    ]);
    expect(d[0]!.message).toMatch(/types can't be found/);
    expect(report().unresolved).toEqual(["no-such-package", "node:child_process-missing-types"]);
  });

  it("covers import = require, dynamic import(), and `declare module` shims", () => {
    const more = checkFiles([path.join(dir, "unresolved-more.ts"), path.join(dir, "shims.d.ts")], {});
    expect(more.unresolved).toEqual(["shimmed-package", "untyped-dynamic", "untyped-require"]);
  });

  it("doesn't mistake a script for an asset because of its query or fragment", () => {
    expect(checkFiles([path.join(dir, "assets.ts")], {}).unresolved).toEqual(["./evil.js#.css", "./evil.js?x=.css"]);
  });

  it("follows the unmapped policy", () => {
    expect(report({ unmapped: "error" }).diagnostics.filter((x) => x.code === "PERM007").every((x) => x.severity === "error")).toBe(true);
    expect(report({ unmapped: "trust" }).diagnostics.filter((x) => x.code === "PERM007")).toEqual([]);
    expect(report({ unmapped: "error", strictness: "sketch" }).diagnostics.filter((x) => x.code === "PERM007").map((x) => x.severity)).toEqual(["error", "error"]);
  });
});
