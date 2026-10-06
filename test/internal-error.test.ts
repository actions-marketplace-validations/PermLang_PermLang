// A bug in PermLang must not look like a failed check: exit code 1 means permission errors and
// nothing else. An internal error exits 2, with the error and where it happened, so it can be
// reported (found in the code review, O2). Bugs are simulated by making one function throw.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, runCliStreams } from "./run-cli.js";

/** What each stand-in throws, when set. */
const fail = vi.hoisted(() => ({ formatText: undefined as unknown, settingsEntries: undefined as unknown, formatDiffMarkdown: undefined as unknown }));

vi.mock("../src/report.js", async (original) => {
  const real = await original<typeof import("../src/report.js")>();
  return {
    ...real,
    formatText: (...args: Parameters<typeof real.formatText>) => {
      if (fail.formatText !== undefined) throw fail.formatText;
      return real.formatText(...args);
    },
  };
});
vi.mock("../src/settings.js", async (original) => {
  const real = await original<typeof import("../src/settings.js")>();
  return {
    ...real,
    settingsEntries: (...args: Parameters<typeof real.settingsEntries>) => {
      if (fail.settingsEntries !== undefined) throw fail.settingsEntries;
      return real.settingsEntries(...args);
    },
  };
});
vi.mock("../src/diff.js", async (original) => {
  const real = await original<typeof import("../src/diff.js")>();
  return {
    ...real,
    formatDiffMarkdown: (...args: Parameters<typeof real.formatDiffMarkdown>) => {
      if (fail.formatDiffMarkdown !== undefined) throw fail.formatDiffMarkdown;
      return real.formatDiffMarkdown(...args);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-bug-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), "export const x = 1;\n");
});
afterEach(() => {
  fail.formatText = fail.settingsEntries = fail.formatDiffMarkdown = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const check = () => runCliStreams(["check", "src", "--no-lock"], { cwd: dir });
const header = /^PermLang hit an internal error\. Please report it at https:\/\/github\.com\/PermLang\/PermLang\/issues, with this:\n/;

describe("an internal error", () => {
  it("exits 2, with the error, the stack, and where to report it", () => {
    fail.formatText = new TypeError("Cannot read properties of undefined (reading 'x')\n::error::not a real annotation");
    const { code, stdout, stderr } = check();
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(header);
    // The message is on one line, so it can't start a workflow command of its own.
    expect(stderr).toContain("TypeError: Cannot read properties of undefined (reading 'x')\\n::error::not a real annotation");
    expect(stderr).toMatch(/\n {4}at /);
  });

  it("reports something thrown that isn't an Error, and an error with a code that isn't a system error's", () => {
    fail.formatText = "a string";
    expect(check().stderr).toMatch(/with this:\nError: a string\n {4}at /);
    fail.formatText = Object.assign(new Error("not about a file"), { code: "ERR_SOMETHING" });
    expect(check().stderr).toMatch(/with this:\nError: not about a file\n {4}at /);
  });

  it("prints only the message when the error has no stack", () => {
    fail.formatText = Object.assign(new Error("no frames"), { stack: "Error: no frames" });
    expect(check().stderr).toBe(`${"PermLang hit an internal error. Please report it at https://github.com/PermLang/PermLang/issues, with this:"}\nError: no frames\n`);
  });

  it("treats a system error, such as a file that can't be read, as expected: its message alone", () => {
    fail.formatText = Object.assign(new Error("EACCES: permission denied, open 'x'"), { code: "EACCES" });
    expect(check()).toEqual({ code: 2, stdout: "", stderr: "EACCES: permission denied, open 'x'\n" });
  });
});

describe("an internal error in `permlang diff`", () => {
  beforeEach(() => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    expect(runCli(["init", "src"], { cwd: dir }).code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });

  it("while analyzing: the diff says the code couldn't be analyzed, and the error is printed to report", () => {
    fail.settingsEntries = new RangeError("Maximum call stack size exceeded");
    const { code, stdout, stderr } = runCliStreams(["diff", "HEAD", "src", "--format", "markdown"], { cwd: dir });
    expect(code).toBe(0);
    expect(stdout).toContain("PermLang couldn't analyze the code");
    expect(stdout).toContain("internal error:\u{200b} Maximum call stack size exceeded");
    expect(stderr).toMatch(header);
  });

  it("while writing the comment: it still prints one that says the diff failed, and exits 2", () => {
    fail.formatDiffMarkdown = "boom";
    const { code, stdout, stderr } = runCliStreams(["diff", "HEAD", "src", "--format", "markdown"], { cwd: dir });
    expect(code).toBe(2);
    expect(stdout).toContain("**PermLang couldn't compute the permission diff**");
    expect(stdout).toContain("internal error:\u{200b} boom");
    expect(stderr).toMatch(header);
  });
});
