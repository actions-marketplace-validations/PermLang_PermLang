// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Bringing the packages another job installed into the checkout (GHSA-chh9-p8fq-3gf9). Installing
// runs code the pull request controls, so it happens in a job of its own, which packs every
// node_modules folder. That job could have packed anything: only node_modules folders (and
// generated folders the workflow names) may come in, as new folders, with links that stay in the
// repository and out of .git.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DependencyImportError, importCommand, importDependencies, importUnpacked } from "../src/dependencies.js";
import { writeTar, type TarEntry } from "./tar.js";
import { removeTemporary } from "./temporary.js";

let dir: string;
let root: string;
let staging: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-deps-"));
  root = path.join(dir, "repo");
  staging = path.join(dir, "staging");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "packages", "web"), { recursive: true });
  mkdirSync(path.join(root, "packages", "api"), { recursive: true });
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, "src", "app.ts"), "export const app = 1;\n");
  mkdirSync(staging);
});

afterEach(() => removeTemporary(dir));

/** Files and links in the staging folder, as the installing job's archive would unpack. */
function stage(files: Record<string, string>, links: Record<string, string> = {}) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
    writeFileSync(path.join(staging, file), content);
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(staging, link)), { recursive: true });
    symlinkSync(target, path.join(staging, link), "dir");
  }
}

const imports = (generated: string[] = []) => () => importUnpacked(staging, root, generated);

/** The checkout's own files: none may change, and none may be added outside what's imported. */
function checkout(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(root, rel))) {
      const entry = rel ? `${rel}/${name}` : name;
      if (lstatSync(path.join(root, entry)).isDirectory()) walk(entry);
      else out.push(entry);
    }
  };
  walk("");
  return out.sort();
}

describe("importing dependencies", () => {
  it("moves each node_modules folder into place, links and all", () => {
    stage(
      {
        "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.d.ts": "export {};\n",
        "packages/web/node_modules/react/index.d.ts": "export {};\n",
      },
      {
        // pnpm links each package to its store, across node_modules folders, and a workspace links its own packages.
        "node_modules/left-pad": ".pnpm/left-pad@1.3.0/node_modules/left-pad",
        "packages/web/node_modules/left-pad": "../../../node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad",
        "packages/web/node_modules/@acme/api": "../../../api",
      },
    );
    expect(imports()()).toEqual(["node_modules", "packages/web/node_modules"]);
    expect(readFileSync(path.join(root, "node_modules", "left-pad", "index.d.ts"), "utf8")).toBe("export {};\n");
    expect(readFileSync(path.join(root, "packages", "web", "node_modules", "left-pad", "index.d.ts"), "utf8")).toBe("export {};\n");
    expect(lstatSync(path.join(root, "packages", "web", "node_modules", "@acme", "api")).isSymbolicLink()).toBe(true);
  });

  it("moves a generated folder only when the workflow names it", () => {
    stage({ "src/generated/prisma/index.d.ts": "export {};\n" });
    expect(imports()).toThrow(/src\/generated\/prisma\/index\.d\.ts, which isn't in a node_modules folder\./);
    expect(imports(["src/generated"])()).toEqual(["src/generated"]);
    expect(existsSync(path.join(root, "src", "generated", "prisma", "index.d.ts"))).toBe(true);
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  it.each<[string, Record<string, string>, Record<string, string>, RegExp]>([
    ["a file outside node_modules", { "node_modules/x/index.d.ts": "", "src/evil.d.ts": "declare const fetch: any;" }, {}, /src\/evil\.d\.ts, which isn't in a node_modules folder/],
    ["a file at the top", { "evil.ts": "" }, {}, /evil\.ts, which isn't in a node_modules folder/],
    ["a node_modules folder that's a link", {}, { "packages/web/node_modules": "../../src" }, /packages\/web\/node_modules as something other than a folder/],
    ["a folder on the way that's a link", { "elsewhere/node_modules/x/index.d.ts": "" }, { packages: "elsewhere" }, /packages, which isn't in a node_modules folder/],
    ["a link out of the repository", {}, { "node_modules/x": "../../outside" }, /node_modules\/x, to .+, outside the repository/],
    ["a link to an absolute path", {}, { "node_modules/x": path.resolve("/outside") }, /node_modules\/x, to an absolute path/],
    ["a link into .git", {}, { "node_modules/x": "../.git" }, /node_modules\/x, into a \.git folder/],
    ["anything in a .git folder", { ".git/node_modules/hooks/x": "" }, {}, /in a \.git folder/],
  ])("refuses %s, and moves nothing", (_, files, links, message) => {
    stage({ "node_modules/ok/index.d.ts": "export {};\n", ...files }, links);
    const before = checkout();
    expect(imports()).toThrow(DependencyImportError);
    expect(imports()).toThrow(message);
    expect(checkout()).toEqual(before);
  });

  it("only adds: a node_modules folder or generated folder the checkout has already isn't replaced", () => {
    mkdirSync(path.join(root, "node_modules", "committed"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "committed", "index.d.ts"), "export {};\n");
    stage({ "node_modules/x/index.d.ts": "" });
    expect(imports()).toThrow("Can't add node_modules: the checkout has it already.");
    stage({ "src/generated/x.d.ts": "" });
    mkdirSync(path.join(root, "src", "generated"));
    expect(imports(["src/generated"])).toThrow(/the checkout has it already/);
  });

  it("doesn't add a folder through a link in the checkout, which would put it somewhere else", () => {
    // A pull request can commit a link, here to a folder outside the repository.
    mkdirSync(path.join(dir, "outside"));
    symlinkSync(path.join(dir, "outside"), path.join(root, "linked"), "dir");
    stage({ "linked/node_modules/x/index.d.ts": "" });
    expect(imports()).toThrow("Can't add linked/node_modules: the way to it in the checkout goes through a link.");
    expect(readdirSync(path.join(dir, "outside"))).toEqual([]);
  });

  it("doesn't add a folder whose parent isn't in the checkout", () => {
    stage({ "tools/node_modules/x/index.d.ts": "" });
    expect(imports()).toThrow("Can't add tools/node_modules: tools isn't in the checkout.");
  });

  it.each(["../outside", "/abs", "C:/abs", ".git/x", "."])("refuses %s as a generated folder", (folder) => {
    expect(imports([folder])).toThrow(/isn't a folder inside the repository/);
  });
});

// The archive itself, unpacked by tar: on Linux and macOS runners only.
describe.skipIf(process.platform === "win32")("importing an archive of dependencies", () => {
  const archive = (entries: TarEntry[]) => {
    const file = path.join(dir, "dependencies.tar");
    writeTar(file, entries);
    return () => importDependencies({ archive: file, root, temp: dir });
  };
  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith("permlang-dependencies-"));

  it("unpacks and moves node_modules, and leaves no temporary folder behind", () => {
    expect(archive([{ type: "dir", path: "node_modules/" }, { type: "file", path: "node_modules/x/index.d.ts", content: "export {};\n" }, { type: "symlink", path: "node_modules/y", target: "x" }])()).toEqual(["node_modules"]);
    expect(readFileSync(path.join(root, "node_modules", "y", "index.d.ts"), "utf8")).toBe("export {};\n");
    expect(leftovers()).toEqual([]);
  });

  it.each<[string, TarEntry[]]>([
    ["a path with ..", [{ type: "file", path: "node_modules/../src/evil.d.ts", content: "" }]],
    ["a path out of the folder", [{ type: "file", path: "../escape.txt", content: "" }]],
    ["an absolute path", [{ type: "file", path: "/src/evil.d.ts", content: "" }]],
    ["a file written through a link", [{ type: "symlink", path: "node_modules/x", target: "../src" }, { type: "file", path: "node_modules/x/evil.d.ts", content: "" }]],
    ["a hard link out of the archive", [{ type: "hardlink", path: "node_modules/x", target: "../../outside.txt" }]],
    ["a named pipe, which would hang the check", [{ type: "fifo", path: "node_modules/x" }]],
  ])("refuses %s, and moves nothing", (_, entries) => {
    writeFileSync(path.join(dir, "outside.txt"), "outside\n");
    const before = checkout();
    expect(archive(entries)).toThrow(DependencyImportError);
    expect(checkout()).toEqual(before);
    expect(existsSync(path.join(dir, "escape.txt"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("says when the archive can't be unpacked", () => {
    writeFileSync(path.join(dir, "broken.tar"), "not a tar archive");
    expect(() => importDependencies({ archive: path.join(dir, "broken.tar"), root, temp: dir })).toThrow(/couldn't be unpacked/);
  });
});

describe.skipIf(process.platform !== "win32")("importing an archive on Windows", () => {
  it("is refused, since tar there unpacks a link as a copy", () => {
    expect(() => importDependencies({ archive: "x.tar", root, temp: dir })).toThrow(/not Windows/);
  });
});

describe("the Action's import step", () => {
  /** Runs it in the checkout; returns the exit code and what it printed. */
  const run = (...args: string[]) => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    const error = vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      return { code: importCommand(args), out: lines.join("\n") };
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      error.mockRestore();
    }
  };

  it("says how to use it", () => {
    expect(run()).toMatchObject({ code: 2, out: expect.stringMatching(/^Usage: import-dependencies/) });
  });

  it("wants exactly one archive", () => {
    const folder = path.join(dir, "download");
    mkdirSync(folder);
    expect(run(folder, dir)).toMatchObject({ code: 1, out: expect.stringContaining("Expected one .tar archive of dependencies in") });
    writeTar(path.join(folder, "a.tar"), []);
    writeTar(path.join(folder, "b.tar"), []);
    expect(run(folder, dir).out).toContain("and found 2.");
  });

  it.skipIf(process.platform !== "win32")("fails on Windows", () => {
    const folder = path.join(dir, "download");
    mkdirSync(folder);
    writeTar(path.join(folder, "deps.tar"), []);
    expect(run(folder, dir)).toMatchObject({ code: 1, out: expect.stringContaining("not Windows") });
  });

  it.skipIf(process.platform === "win32")("imports, and says what", () => {
    const folder = path.join(dir, "download");
    mkdirSync(folder);
    writeTar(path.join(folder, "deps.tar"), [{ type: "file", path: "node_modules/x/index.d.ts", content: "export {};\n" }, { type: "file", path: "src/generated/client.d.ts", content: "export {};\n" }]);
    expect(run(folder, dir, "src/generated")).toEqual({ code: 0, out: "Imported node_modules, src/generated." });
  });

  // The names come from the archive: none may start a line, which GitHub Actions would read as a command.
  it.skipIf(process.platform === "win32")("starts every line with its own words, and escapes the archive's names", () => {
    const folder = path.join(dir, "download");
    mkdirSync(folder);
    writeTar(path.join(folder, "deps.tar"), [{ type: "file", path: "x\n::error::forged", content: "" }]);
    const { code, out } = run(folder, dir);
    expect(code).toBe(1);
    // The line break, written as a backslash and an n: one line, which starts with the step's own words.
    const escaped = `x${String.fromCharCode(92)}n::error::forged`;
    expect(out).toBe(`Couldn't import the dependencies. The archive of dependencies has ${escaped}, which isn't in a node_modules folder.`);
    expect(out.split("\n")).toHaveLength(1);
  });
});
