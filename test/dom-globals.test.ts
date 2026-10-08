// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// `window.fetch` and `self.fetch` resolve to lib.dom's WindowOrWorkerGlobalScope.fetch, not to the
// global function, so they need their own match. The conformance fixtures share one project
// without lib.dom, which is why this runs as a separate project.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

let dir: string;
let report: Report;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-dom-"));
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, lib: ["ES2022", "DOM"] },
    include: ["*.ts"],
  }));
  writeFileSync(path.join(dir, "app.ts"), [
    "export async function viaWindow(u: string) { return window.fetch(u); }",
    "export async function viaSelf() { return self.fetch(\"https://evil.example/x\"); }",
    "export async function viaGlobalThis(u: string) { return globalThis.fetch(u); }",
    "const notTheNetwork = { fetch: (u: string) => u };",
    "export function localFetch(u: string) { return notTheNetwork.fetch(u); }",
  ].join("\n"));
  report = checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}, 60_000);

afterAll(() => removeTemporary(dir));

const reached = (fn: string) =>
  report.diagnostics.filter((d) => d.message.includes(`${fn} `)).map((d) => d.message).join("\n");

describe("browser globals", () => {
  it("detects window.fetch", () => expect(reached("viaWindow")).toMatch(/fetch/));
  it("detects self.fetch", () => expect(reached("viaSelf")).toContain("self.fetch(\"https://evil.example/x\")"));
  it("still detects globalThis.fetch", () => expect(reached("viaGlobalThis")).toMatch(/fetch/));
  it("ignores a local method that happens to be named fetch", () => expect(reached("localFetch")).toBe(""));
});
