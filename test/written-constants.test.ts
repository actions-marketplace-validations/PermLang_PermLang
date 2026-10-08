// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// A module's exported constants, read by name in other files, are fixed only where the module's
// namespace object is: in CommonJS, `import * as config` is the module's `exports` object, so
// writing to it changes what every importer reads; an ES module's namespace can't be written.
// Each runs as its own project, since the module format is a compiler option.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const dirs: string[] = [];

function check(compilerOptions: object, files: Record<string, string>): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-constants-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", strict: true, lib: ["ES2022", "DOM"], types: [], ...compilerOptions },
    include: ["*.ts", "*.mts"],
  }));
  for (const [name, code] of Object.entries(files)) writeFileSync(path.join(dir, name), code);
  return checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}

afterAll(() => dirs.forEach(removeTemporary));

const errors = (report: Report, fn: string) =>
  report.diagnostics.filter((d) => d.function === fn && d.severity === "error").map((d) => `${d.code} ${d.capability}`);

/** The project's files, importing each other with `ext` after the name (ES modules under nodenext need `.js`). */
const files = (ext: string): Record<string, string> => ({
  "config.ts": "export const API_URL = \"https://good.example/collect\";\nexport const ROUTES = { api: \"https://good.example/api\" } as const;",
  "poison.ts": `import * as config from "./config${ext}";\n// Runs when imported, and changes the constants for every importer.\nObject.assign(config, { API_URL: "https://evil.example/collect", ROUTES: { api: "https://evil.example/api" } });\nexport {};`,
  "app.ts": `import "./poison${ext}";\nimport { API_URL, ROUTES } from "./config${ext}";\n/** @perm net(good.example) */\nexport function send() { return fetch(API_URL); }\n/** @perm net(good.example) */\nexport function route() { return fetch(ROUTES.api); }`,
  // Written through `import x = require()`, the other way TypeScript names a CommonJS module's exports.
  "other.ts": "export const OTHER_URL = \"https://good.example/other\";",
  "other-poison.ts": `import other = require("./other${ext}");\nObject.assign(other, { OTHER_URL: "https://evil.example/other" });\nexport {};`,
  "other-app.ts": `import { OTHER_URL } from "./other${ext}";\n/** @perm net(good.example) */\nexport function sendOther() { return fetch(OTHER_URL); }`,
  // Only read, and re-exported (a re-export doesn't write anything).
  "kept.ts": "export const KEPT_URL = \"https://good.example/kept\";",
  "kept-barrel.ts": `export { KEPT_URL } from "./kept${ext}";`,
  "reader.ts": `import * as kept from "./kept${ext}";\n/** @perm net(good.example) */\nexport function read() { return [fetch(kept.KEPT_URL), Object.keys(kept)]; }`,
});

describe.each([
  ["module commonjs", { module: "commonjs", moduleResolution: "node10" }, files("")],
  ["module nodenext, in a package that isn't an ES module", { module: "nodenext", moduleResolution: "nodenext" }, files("")],
  ["no module, with target ES5 (CommonJS by default)", { target: "ES5" }, files("")],
  ["neither module nor target (CommonJS by default)", { target: undefined }, files("")],
])("constants exported from a CommonJS module (%s)", (_, options, project) => {
  const report = check(options, project);

  it("are unknown once another file writes to the module's exports", () => {
    expect(errors(report, "send")).toEqual(["PERM001 net"]);
    expect(errors(report, "route")).toEqual(["PERM001 net"]);
    expect(errors(report, "sendOther")).toEqual(["PERM001 net"]);
  });

  it("are still read from a module whose exports nothing writes", () => expect(errors(report, "read")).toEqual([]));
});

describe.each([
  ["module esnext", { module: "esnext", moduleResolution: "bundler" }, files("")],
  ["module nodenext, in a package that is", { module: "nodenext", moduleResolution: "nodenext" }, { ...files(".js"), "package.json": "{ \"type\": \"module\" }" }],
  ["no module, with target ES2022 (ES modules by default)", {}, files("")],
])("constants exported from an ES module (%s)", (_, options, project) => {
  // Object.assign on an ES module's namespace throws, so the constants keep their values.
  const report = check(options, project);

  it("are read as written", () => {
    expect(errors(report, "send")).toEqual([]);
    expect(errors(report, "route")).toEqual([]);
    expect(errors(report, "sendOther")).toEqual([]);
    expect(errors(report, "read")).toEqual([]);
  });
});

describe("constants exported from an .mts file in a package that isn't an ES module", () => {
  // An .mts file is an ES module whatever its package says, so its namespace can't be written.
  const report = check({ module: "nodenext", moduleResolution: "nodenext" }, {
    "config.mts": "export const API_URL = \"https://good.example/collect\";",
    "poison.ts": "import * as config from \"./config.mjs\";\nObject.assign(config, { API_URL: \"https://evil.example/collect\" });\nexport {};",
    "app.ts": "import \"./poison\";\nimport { API_URL } from \"./config.mjs\";\n/** @perm net(good.example) */\nexport function send() { return fetch(API_URL); }",
  });

  it("are read as written", () => expect(errors(report, "send")).toEqual([]));
});
