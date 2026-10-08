// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Engine behaviour that needs a project of its own: package boundaries for declaration
// files, reusing a ts-morph Project, very long call chains, and very deep expressions.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { checkFiles, checkProject, checkTsConfig, type Report } from "../src/check.js";
import { holderOf, pathTo, propagate, type Edge } from "../src/graph.js";
import type { Unit } from "../src/units.js";
import { lineAndColumn } from "../src/walk.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

/** Writes `files` into a new folder with a tsconfig.json, and returns that tsconfig's path. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-engine-"));
  dirs.push(dir);
  const tsconfig = {
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots },
    include: ["src"],
  };
  for (const [file, text] of Object.entries({ "tsconfig.json": JSON.stringify(tsconfig), ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return path.join(dir, "tsconfig.json");
}

afterAll(() => {
  for (const dir of dirs) removeTemporary(dir);
});

const errors = (report: Report, file: string) =>
  report.diagnostics.filter((d) => d.severity === "error" && d.file.endsWith(file)).map((d) => `${d.line} ${d.code} ${d.capability}`);

describe("declaration files for the project's own JavaScript", () => {
  it("are unverifiable inside the project's package, and a package with no adapter in a package of their own", () => {
    const report = checkTsConfig(project({
      "package.json": JSON.stringify({ name: "app", type: "module" }),
      // Hand-written types for the project's own legacy.js.
      "src/legacy.d.ts": "export declare function run(cmd: string): string;\n",
      // A generated client in its own package (as Prisma's custom output is): a dependency, not the
      // project's code. (Prisma's own imports its runtime, and is covered by the Prisma detector.)
      "src/generated/client/package.json": JSON.stringify({ name: "prisma-client-generated" }),
      "src/generated/client/index.d.ts": "export declare class PrismaClient { $connect(): Promise<void>; }\n",
      "src/app.ts": [
        'import { run } from "./legacy.js";',
        'import { PrismaClient } from "./generated/client/index.js";',
        "/** @perm env(MODE) */",
        "export async function t() {",
        "  await new PrismaClient().$connect();",
        "  return run(process.env.MODE ?? \"\");",
        "}",
      ].join("\n"),
    }));
    expect(errors(report, "app.ts")).toEqual(["6 PERM004 unverifiable"]);
    expect(report.unmapped.map((u) => u.package)).toEqual(["prisma-client-generated"]);
    // The declarations themselves aren't functions PermLang analyzed, so they aren't reported or locked.
    expect(report.functions.map((f) => f.name)).toEqual(["t"]);
    const d = report.diagnostics.find((x) => x.code === "PERM004");
    expect(d?.message).toMatch(/reaching run → JavaScript declared in legacy\.d\.ts\n/);
    // The fix names something that can carry @perm-unsafe, not the declaration.
    expect(d?.fix).toBe("convert legacy.js to TypeScript so PermLang can check it, or review it and mark t @perm-unsafe with a reason.");
  });

  it("from top-level code, suggest wrapping the call in a function that can carry @perm-unsafe", () => {
    const report = checkTsConfig(project({
      "src/legacy.d.ts": "export declare function run(cmd: string): string;\n",
      "src/app.ts": 'import { run } from "./legacy.js";\nrun("migrate");\n',
    }));
    expect(report.diagnostics.map((d) => d.fix)).toEqual([
      "convert legacy.js to TypeScript so PermLang can check it, or review it and mark a function that wraps the call @perm-unsafe with a reason.",
    ]);
  });
});

describe("suggested fixes", () => {
  it("point at something an annotation attaches to", () => {
    const report = checkTsConfig(project({
      "src/app.ts": [
        'import { execSync } from "node:child_process";',
        'execSync("ls");',
        "export class Loader {",
        '  data = fetch("https://loader.example/");',
        "}",
        "eval(\"1\");",
      ].join("\n"),
    }));
    const fix = (code: string, capability: string) => report.diagnostics.find((d) => d.code === code && d.capability === capability)?.fix;
    expect(fix("PERM003", "exec")).toBe("add /** @module @perm exec */ at the top of the file.");
    expect(fix("PERM003", "net(loader.example)")).toBe("add /** @perm net(loader.example) */ above class Loader.");
    expect(fix("PERM004", "unverifiable")).toBe("rewrite it so what it calls is known statically, or move it into a function marked @perm-unsafe with a reason.");
  });

  it("name a class expression by what holds it, or ask for a constructor when nothing does", () => {
    const report = checkTsConfig(project({
      "src/app.ts": [
        'export const Lazy = class { data = fetch("https://lazy.example/"); };',
        'export function make() { return class { data = fetch("https://made.example/"); }; }',
      ].join("\n"),
    }), { strictness: "production" });
    const fix = (capability: string) => report.diagnostics.find((d) => d.capability === capability)?.fix;
    expect(fix("net(lazy.example)")).toBe("add /** @perm net(lazy.example) */ above class Lazy.");
    expect(fix("net(made.example)")).toBe("add a constructor to the class, with /** @perm net(made.example) */.");
  });
});

describe("classes built by expressions", () => {
  it("are linked to `new` through their type, and named after where they're built", () => {
    const report = checkTsConfig(project({
      "src/app.ts": [
        'import { execSync } from "node:child_process";',
        'function make() { return class { x = execSync("ls"); }; }',
        "export function t() { const K = make(); return new K(); }",
        'export const Named = class { y = execSync("pwd"); };',
        'export const made = new (class { z = execSync("id"); })();',
      ].join("\n"),
    }));
    expect(report.functions.map((f) => f.name).sort()).toEqual(["<class>.constructor", "<module>", "Named.constructor", "make.<class>.constructor", "t"]);
  });
});

describe("reusing a ts-morph Project", () => {
  it("gives fresh results after the code changes", () => {
    const dir = path.dirname(project({}));
    const reused = new Project({ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, strict: true, types: ["node"], typeRoots } });
    const file = reused.createSourceFile(path.join(dir, "a.ts"), 'import { basename as run } from "node:path";\nexport function t(x: string) { return run(x); }\n');
    expect(checkProject(reused).functions).toEqual([]);
    // Only the import changes: the same call now runs a command.
    file.getImportDeclarations()[0]!.setModuleSpecifier("node:child_process");
    file.getImportDeclarations()[0]!.getNamedImports()[0]!.setName("execSync");
    expect(checkProject(reused).functions.map((f) => [f.name, f.actual])).toEqual([["t", ["exec"]]]);
  });
});

describe("long call chains", () => {
  // A chain of 20,000 functions, each calling the next; the last runs a command.
  const unit = (i: number): Unit => ({ node: undefined as never, file: "a.ts", name: `f${i}`, line: i + 1, exported: false, own: undefined, module: undefined, uses: [] });
  const chain = Array.from({ length: 20_000 }, (_, i) => unit(i));
  chain.at(-1)!.uses.push({ verb: "calls", capability: { name: "exec" }, call: 'execSync("ls")', line: 20_000, column: 1 });
  const edges: Edge[] = chain.slice(1).map((to, i) => ({ from: chain[i]!, to, call: `f${i + 1}()`, line: i + 1, column: 1 }));

  it("propagate in linear time", () => {
    const started = performance.now();
    const reach = propagate(chain, edges);
    for (const u of chain) pathTo(reach, u, "exec");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(reach.get(chain[0]!)!.has("exec")).toBe(true);
  });

  it("shorten long paths in messages, keeping both ends", () => {
    const reach = propagate(chain, edges);
    const shown = pathTo(reach, chain[0]!, "exec");
    expect(shown.length).toBeLessThan(30);
    expect(shown.slice(0, 2)).toEqual(["f1", "f2"]);
    expect(shown.slice(-2)).toEqual(["f19999", 'execSync("ls")']);
    expect(pathTo(reach, chain[19_997]!, "exec")).toEqual(["f19998", "f19999", 'execSync("ls")']);
    // A capability a function doesn't reach has no path, and nothing holds it but the function.
    expect(pathTo(reach, chain[0]!, "net")).toEqual([]);
    expect(holderOf(reach, chain[0]!, "net")).toBe(chain[0]);
    expect(holderOf(reach, chain[0]!, "exec")).toBe(chain.at(-1));
  });
});

describe("positions", () => {
  it("match ts-morph's line and column for any text", () => {
    const files = new Project({ useInMemoryFileSystem: true });
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", " ", "\n", "\r", "\r\n", "\u2028", "é", "😀"), { maxLength: 60 }), (parts) => {
        const file = files.createSourceFile("/x.ts", parts.join(""), { overwrite: true });
        for (let pos = 0; pos <= file.getFullText().length; pos++) {
          expect(lineAndColumn(file, pos)).toEqual(file.getLineAndColumnAtPos(pos));
        }
      }),
    );
  });

  it("are found quickly in a file with thousands of functions", () => {
    const lines = ['import { execSync } from "node:child_process";'];
    for (let i = 9_999; i >= 1; i--) lines.push(`function f${i}() { f${i - 1}(); }`);
    lines.push('function f0() { execSync("ls"); }', "export function t() { f9999(); }");
    const tsconfig = project({ "src/chain.ts": lines.join("\n") });
    const started = performance.now();
    const report = checkTsConfig(tsconfig);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(report.diagnostics.map((d) => `${d.line} ${d.code} ${d.function}`)).toEqual(["10002 PERM003 t"]);
  });
});

describe("very deeply nested code", () => {
  it("is analyzed when it's valid, such as a 10,000-term concatenation", () => {
    const deep = `export function t(x: string) { return fetch("https://deep.example/") + x${' + "a"'.repeat(10_000)}; }\n`;
    const report = checkTsConfig(project({ "src/deep.ts": deep }));
    expect(errors(report, "deep.ts")).toEqual(["1 PERM003 net(deep.example)"]);
  });

  it("is reported as unverifiable when it can't be analyzed, and the other files still are", () => {
    const report = checkTsConfig(project({
      "src/nested.ts": `export const v = ${"(".repeat(5_000)}1${")".repeat(5_000)};\n`,
      // It imports the file that can't be parsed, and gets an empty module.
      "src/ok.ts": 'import * as nested from "./nested.js";\nexport function t() { return fetch("https://ok.example/"); }\nexport { nested };\n',
    }));
    expect(errors(report, "nested.ts")).toEqual(["1 PERM004 unverifiable"]);
    expect(report.diagnostics.find((d) => d.file.endsWith("nested.ts"))?.message).toMatch(/couldn't be analyzed \(its code is nested too deeply\)/);
    // Importing it runs what it stands for.
    expect(errors(report, "ok.ts")).toEqual(["1 PERM004 unverifiable", "2 PERM003 net(ok.example)"]);
    expect(report.diagnostics.find((d) => d.file.endsWith("nested.ts"))?.fix).toMatch(/^simplify the file/);
  });

  it("is reported the same way through checkFiles, with paths or patterns", () => {
    const tsconfig = project({
      "src/nested.ts": `export const v = ${"[".repeat(5_000)}1${"]".repeat(5_000)};\n`,
      "src/other.ts": 'export function t() { return fetch("https://other.example/"); }\n',
    });
    const src = path.join(path.dirname(tsconfig), "src").replaceAll("\\", "/");
    const report = checkFiles([`${src}/nested.ts`, `${src}/o*.ts`]);
    expect(errors(report, "nested.ts")).toEqual(["1 PERM004 unverifiable"]);
    expect(errors(report, "other.ts")).toEqual(["1 PERM003 net(other.example)"]);
  });

  it("doesn't hide other problems loading a project", () => {
    expect(() => checkTsConfig(path.join(path.dirname(project({})), "missing", "tsconfig.json"))).toThrow();
  });
});
