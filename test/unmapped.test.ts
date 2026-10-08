// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Packages with no adapter are trusted: PermLang can't see what they touch
// (design doc decision D1). The trial showed this is the largest gap in practice,
// so every such package is listed in the report and, by default, warned about.
// Packages known to touch nothing are declared pure in adapters/pure.json.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkFiles, checkTsConfig, type CheckOptions } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

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

// A folder of the project's with its own package.json is a package: a client generated into
// the project, or a workspace package reached through a link. The JavaScript behind its .d.ts
// isn't analyzed, so it's trusted, listed, and warned about, like a package with no adapter.
// Found in re-verification: such a folder, claiming to be a generated Prisma client, hid a
// command with no diagnostic at all.
describe("folders with their own package.json", () => {
  const temporary: string[] = [];
  const insidePackage = (dir: string): boolean => existsSync(path.join(dir, "package.json")) || (path.dirname(dir) !== dir && insidePackage(path.dirname(dir)));
  afterAll(() => {
    for (const d of temporary) removeTemporary(d);
  });

  /** A project in `<base>/app`; files may be outside it (`../outside/lib.d.ts`). */
  function project(files: Record<string, string>, options: CheckOptions = {}) {
    const base = mkdtempSync(path.join(tmpdir(), "permlang-unmapped-"));
    temporary.push(base);
    const root = path.join(base, "app");
    const tsconfig = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: [] }, include: ["src"] };
    const all = { "package.json": JSON.stringify({ name: "app", type: "module" }), "tsconfig.json": JSON.stringify(tsconfig), ...files };
    for (const [file, text] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    const adapters = Object.keys(files).filter((f) => f.startsWith("adapters/")).map((f) => path.join(root, f));
    return checkTsConfig(path.join(root, "tsconfig.json"), { adapters, ...options });
  }

  /** A folder named `name` (none if undefined) whose JavaScript runs a command, and code that calls it. */
  const folder = (name: string | undefined, header = "") => ({
    "src/gen/package.json": JSON.stringify(name === undefined ? { main: "db.js" } : { name, main: "db.js", types: "db.d.ts" }),
    "src/gen/db.d.ts": `${header}export declare class Client { run(cmd: string): unknown; }\n`,
    "src/gen/db.js": 'import { execSync } from "node:child_process";\nexport class Client { run(c) { return execSync(c); } }\n',
    "src/a.ts": 'import { Client } from "./gen/db.js";\n/** @perm db.read */\nexport function report(cmd: string) {\n  return new Client().run(cmd);\n}\n',
  });
  const PRISMA_HEADER = "/* !!! This is code generated by Prisma. Do not edit directly. !!! */\n";
  const warnings = (report: ReturnType<typeof project>) => report.diagnostics.filter((d) => d.code === "PERM006");

  it("are listed and warned about by their package.json name, wherever they're imported from", () => {
    const report = project({ ...folder("acme-client"), "src/deep/b.ts": 'import { Client } from "../gen/db.js";\nexport const shared = new Client();\n' });
    expect(report.unmapped).toEqual([{ package: "acme-client", calls: 3, file: expect.stringMatching(/a\.ts$/), line: 4 }]);
    expect(warnings(report)).toEqual([
      expect.objectContaining({
        severity: "warning",
        capability: "acme-client",
        line: 4,
        message: "report calls into acme-client (3 calls in 2 files), the package in ./gen, which has no adapter, so what its JavaScript touches isn't checked.",
        fix: 'add an adapter manifest for acme-client to "adapters" in permlang.config.json, or declare it pure with "default": [] (see docs/reference.md). Built-in adapters don\'t cover a folder in the repository.',
      }),
    ]);
  });

  // The re-verification's repro: Prisma's header doesn't make a folder a generated client. Prisma's
  // own output there imports its runtime (test/prisma.test.ts).
  it("fail the check under \"unmapped\": \"error\", even when they claim to be generated by Prisma", () => {
    const report = project(folder("prisma-client-x", PRISMA_HEADER), { unmapped: "error", strictness: "production" });
    expect(warnings(report).map((d) => `${d.severity} ${d.capability}`)).toEqual(["error prisma-client-x"]);
  });

  it("are named by their folder when package.json has no name", () => {
    expect(project(folder(undefined)).unmapped.map((u) => u.package)).toEqual(["./src/gen"]);
    // Nor when it has no usable name, or can't be read.
    for (const text of ["null", '"gen"', "[1]", '{ "name": 5 }', '{ "name": "  " }', "{ not json"]) {
      expect(project({ ...folder(undefined), "src/gen/package.json": text }).unmapped.map((u) => u.package), text).toEqual(["./src/gen"]);
    }
  });

  it("are named by their whole path outside the project's own packages", () => {
    const report = project({
      "../outside/package.json": JSON.stringify({ main: "lib.js" }),
      "../outside/lib.d.ts": "export declare function run(cmd: string): void;\n",
      "src/a.ts": 'import { run } from "../../outside/lib.js";\nexport function t(c: string) { return run(c); }\n',
    });
    const [outside] = report.unmapped.map((u) => u.package);
    expect(outside).toMatch(/\/outside$/);
    expect(path.isAbsolute(outside!)).toBe(true);
  });

  // A .d.ts outside every package.json is named by its own folder. (Skipped where the
  // system's temporary folder is inside a package.)
  it.skipIf(insidePackage(tmpdir()))("are named by their folder when no package.json holds them", () => {
    const report = project({
      "../loose/lib.d.ts": "export declare function run(cmd: string): void;\n",
      "src/a.ts": 'import { run } from "../../loose/lib.js";\nexport function t(c: string) { return run(c); }\n',
    });
    const [loose] = report.unmapped.map((u) => u.package);
    expect(loose).toMatch(/\/loose$/);
    expect(path.isAbsolute(loose!)).toBe(true);
  });

  it("are named in the message by where they are from the code that calls them", () => {
    const message = (report: ReturnType<typeof project>) => warnings(report)[0]?.message;
    const gen = { "src/gen/package.json": JSON.stringify({ name: "acme-client" }), "src/gen/db.d.ts": folder("acme-client")["src/gen/db.d.ts"] };
    const deeper = project({ ...gen, "src/deep/b.ts": 'import { Client } from "../gen/db.js";\nexport const shared = new Client();\n' });
    expect(message(deeper)).toMatch(/, the package in \.\.\/gen, /);
    // Code in a package of its own, inside the folder it calls into.
    const inside = project({ ...gen, "src/gen/app/package.json": JSON.stringify({ name: "inner" }), "src/gen/app/b.ts": 'import { Client } from "../db.js";\nexport const shared = new Client();\n' });
    expect(message(inside)).toMatch(/, the package in \.\., /);
  });

  it("can be covered by a team's adapter for that name, but not by a built-in one", () => {
    const mapped = project({ ...folder("acme-client"), "adapters/acme.json": JSON.stringify({ permlang: 1, package: "acme-client", default: ["exec"] }) });
    expect(mapped.unmapped).toEqual([]);
    expect(mapped.functions.find((f) => f.name === "report")?.actual).toEqual(["exec"]);
    const pure = project({ ...folder("acme-client"), "adapters/acme.json": JSON.stringify({ permlang: 1, package: "acme-client", default: [] }) });
    expect(pure.unmapped).toEqual([]);
    expect(pure.diagnostics).toEqual([]);
    // A package.json can claim any name: a folder can't borrow lodash's pure adapter, or the Prisma detector's place.
    for (const name of ["lodash", "@prisma/client", ".prisma"]) {
      expect(project(folder(name)).unmapped.map((u) => u.package)).toEqual([name]);
    }
  });
});
