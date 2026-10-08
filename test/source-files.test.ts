// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Rules for every file in the repository, as git lists them.
//
// Each source file says its license in its first lines (SPDX), so a copied file keeps it.
// No file has an invisible character, or one that changes the direction text is shown in:
// those make code read differently in a review from how it runs ("Trojan Source",
// CVE-2021-42574). Write such a character as an escape, such as \u00A0, instead.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

describe("every source file", () => {
  const sources = files.filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f) && !f.startsWith("fixtures/") && !/^test\/[^/]+-fixtures\//.test(f));

  it("is found", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("starts with its SPDX license and copyright lines", () => {
    const missing = sources.filter((f) => {
      const lines = readFileSync(f, "utf8").split("\n");
      const header = lines[0]?.startsWith("#!") ? lines.slice(1, 3) : lines.slice(0, 2);
      return header.join("\n") !== "// SPDX-License-Identifier: Apache-2.0\n// SPDX-FileCopyrightText: The PermLang Authors";
    });
    expect(missing).toEqual([]);
  });
});

describe("every text file", () => {
  // Code points, so no editor or tool can turn them into the characters themselves.
  const HIDDEN: readonly [number, number][] = [
    [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x85, 0x85], [0xa0, 0xa0], [0xad, 0xad],
    [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180e, 0x180e],
    [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x3000, 0x3000], [0x3164, 0x3164],
    [0xfe00, 0xfe0e], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  ];
  // U+FE0F asks for an emoji's colour form, as in the README's ⚠️ and 1️⃣. It's allowed only
  // after an emoji, or before the keycap mark (U+20E3) that makes a digit one.
  const EMOJI_STYLE = 0xfe0f;
  const KEYCAP = 0x20e3;
  const binary = /\.(png|jpe?g|gif|ico|webp|tgz|gz|zip|woff2?)$/i;

  it("has no invisible characters, and none that change the direction text is shown in", () => {
    const found: string[] = [];
    for (const file of files.filter((f) => !binary.test(f))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const points = [...line].map((ch) => ch.codePointAt(0)!);
        points.forEach((cp, j) => {
          const emoji = cp === EMOJI_STYLE && ((points[j - 1] ?? 0) >= 0x2000 || points[j + 1] === KEYCAP);
          const hidden = HIDDEN.some(([low, high]) => cp >= low && cp <= high) || (cp === EMOJI_STYLE && !emoji);
          if (hidden) found.push(`${file}:${i + 1}: U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
        });
      });
    }
    expect(found).toEqual([]);
  });
});
