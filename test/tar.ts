// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Writes tar archives byte by byte, for tests: an archive another job made can hold anything,
// including entries no tar program would write (`..` in a path, a link to anywhere), so the tests
// build those by hand.

import { writeFileSync } from "node:fs";

export type TarEntry =
  | { type: "file"; path: string; content?: string }
  | { type: "dir"; path: string }
  | { type: "symlink"; path: string; target: string }
  | { type: "hardlink"; path: string; target: string }
  | { type: "fifo"; path: string };

const TYPES = { file: "0", hardlink: "1", symlink: "2", dir: "5", fifo: "6" } as const;

/** A ustar archive of these entries, written to `file`. Paths up to 100 characters. */
export function writeTar(file: string, entries: readonly TarEntry[]): void {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.type === "file" ? (entry.content ?? "") : "", "utf8");
    const header = Buffer.alloc(512, 0);
    const field = (offset: number, length: number, value: string) => header.write(value, offset, length, "utf8");
    const octal = (offset: number, length: number, value: number) => field(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
    if (Buffer.byteLength(entry.path) > 100) throw new Error(`test tar: path too long: ${entry.path}`);
    field(0, 100, entry.path);
    octal(100, 8, entry.type === "dir" ? 0o755 : 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, content.length);
    octal(136, 12, 0);
    field(148, 8, "        ");
    field(156, 1, TYPES[entry.type]);
    if (entry.type === "symlink" || entry.type === "hardlink") field(157, 100, entry.target);
    field(257, 6, "ustar\0");
    field(263, 2, "00");
    const sum = header.reduce((a, b) => a + b, 0);
    field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  writeFileSync(file, Buffer.concat(blocks));
}
