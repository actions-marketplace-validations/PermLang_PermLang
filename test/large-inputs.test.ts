// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// A pull request controls the size of what PermLang reads. Reading a comment's tags, and finding
// each package.json script's line, went back to the start of the text each time, so tens of
// thousands of them took minutes (found by the threat model: 32,000 tags, 27 seconds). Each now
// takes time in proportion to its own line.

import { describe, expect, it } from "vitest";
import { isModuleComment } from "../src/annotations.js";
import { readManifest } from "../src/package-files.js";
import { lineIndex, lineStarts } from "../src/lines.js";

/** How long `run` takes, in milliseconds. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("large inputs", () => {
  it("reads a comment with 50,000 tags in seconds", () => {
    const comment = `/**\n${" * @file\n".repeat(50_000)} */`;
    let module = false;
    expect(timed(() => (module = isModuleComment(comment)))).toBeLessThan(5_000);
    expect(module).toBe(true);
  });

  it("finds the lines of 50,000 package.json scripts in seconds", () => {
    const scripts = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`s${i}`, `echo ${i}`]));
    const text = JSON.stringify({ name: "app", scripts }, null, 2);
    const at: { line: number; column: number }[] = [];
    const sink = { add: (_c: string, _t: string, position: { line: number; column: number }) => void at.push(position), unverifiable: () => {} };
    expect(timed(() => readManifest("package.json", text, sink))).toBeLessThan(5_000);
    expect(at).toHaveLength(50_000);
    // Each one where it's written: the first script is on line 4, the last before the closing braces.
    expect(at[0]).toEqual({ line: 4, column: 5 });
    expect(at.at(-1)).toEqual({ line: 50_003, column: 5 });
  });
});

describe("line positions", () => {
  it.each([
    ["", 0, 0],
    ["abc", 2, 0],
    ["a\nb", 1, 0],
    ["a\nb", 2, 1],
    ["a\n\nb", 3, 2],
    ["a\nb\n", 4, 2],
  ])("in %j, offset %i is on line %i (from 0)", (text, offset, line) => {
    expect(lineIndex(lineStarts(text), offset)).toBe(line);
  });
});
