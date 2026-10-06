// When analyzing one file fails, that file is reported as unverifiable and the rest of the
// project is still checked. The failures are simulated: real ones (code nested too deeply
// for a recursive pass) are in engine.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkFiles } from "../src/check.js";

vi.mock("../src/detect/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/detect/index.js")>();
  return {
    ...original,
    detectInFile: (...args: Parameters<typeof original.detectInFile>) => {
      if (args[0].getBaseName() === "detect-fails.ts") throw new Error("simulated detector failure");
      return original.detectInFile(...args);
    },
  };
});

vi.mock("../src/graph.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/graph.js")>();
  return {
    ...original,
    collectEdges: (...args: Parameters<typeof original.collectEdges>) => {
      // Not an Error: anything thrown is reported.
      if (args[0].getBaseName() === "edges-fail.ts") throw "simulated call-graph failure";
      return original.collectEdges(...args);
    },
  };
});

const dir = mkdtempSync(path.join(tmpdir(), "permlang-isolation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a file that can't be analyzed", () => {
  it("is unverifiable, and the others are checked as usual", () => {
    const files = {
      "detect-fails.ts": 'export function a() { return fetch("https://a.example/"); }\n',
      "edges-fail.ts": "export function b() { return 1; }\n",
      "ok.ts": 'export function c() { return fetch("https://c.example/"); }\n',
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    const report = checkFiles(Object.keys(files).map((f) => path.join(dir, f)));
    const shown = report.diagnostics.map((d) => `${path.basename(d.file)}:${d.line} ${d.code} ${d.function} ${d.capability}`);
    expect(shown).toEqual([
      "detect-fails.ts:1 PERM004 <module> unverifiable",
      "edges-fail.ts:1 PERM004 <module> unverifiable",
      "ok.ts:1 PERM003 c net(c.example)",
    ]);
    expect(report.diagnostics[0]!.message).toMatch(/couldn't be analyzed \(simulated detector failure\)/);
    expect(report.diagnostics[1]!.message).toMatch(/couldn't be analyzed \(simulated call-graph failure\)/);
  });
});
