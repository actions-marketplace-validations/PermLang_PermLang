// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// `permlang check --base <ref>`, which the Action runs on pull requests and merge-queue entries:
// the base commit decides whether the lock file is required, and a change can't leave the base's
// lock behind by pointing the Action at another lock file or folder (found by the second
// verification: a pull request that changed `args` to `--lock permlang.lock.v2.json` passed with
// new access, and the comment said only that the base had no such file).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locksRead, permLangSteps } from "../src/lock-moves.js";
import { runCli } from "./run-cli.js";
import { removeTemporary } from "./temporary.js";

let dir: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const permlang = (cwd: string, ...args: string[]) => runCli(args, { cwd: path.join(dir, cwd), env: { GITHUB_WORKSPACE: dir } });

function write(file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

/** A workflow that runs the PermLang Action once for each step's inputs. */
function workflow(file: string, ...steps: Record<string, string>[]) {
  const lines = ["on: pull_request", "jobs:", "  permissions:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v7"];
  for (const { uses = "PermLang/permlang@v0", ...inputs } of steps) {
    lines.push(`      - uses: ${uses}`);
    if (Object.keys(inputs).length > 0) lines.push("        with:", ...Object.entries(inputs).map(([k, v]) => `          ${k}: ${v}`));
  }
  write(`.github/workflows/${file}`, `${lines.join("\n")}\n`);
}

/** A project at sketch strictness, so only the lock decides. */
function app(folder: string, host = "api.example.com") {
  write(`${folder}/src/app.ts`, `export async function ping() {\n  return fetch("https://${host}/");\n}\n`);
  write(`${folder}/permlang.config.json`, `{ "strictness": "sketch" }\n`);
}

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-base-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
});

afterEach(() => removeTemporary(dir));

describe("permlang check --base", () => {
  it("requires the lock the base commit has, and passes when nothing moved", () => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    expect(permlang(".", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    rmSync(path.join(dir, "permlang.lock.json"));
    const { code, out } = permlang(".", "check", "src", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain("error PERM005: permlang.lock.json is missing.");
    expect(permlang(".", "check", "src", "--no-lock", "--base", base)).toMatchObject({ code: 2, out: expect.stringMatching(/^--no-lock turns off the comparison with permlang\.lock\.json, which the base commit has\./) });
  });

  it("fails a change that points the Action at a new lock file", () => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    // The pull request: new access, approved in a lock file of its own.
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --lock permlang.lock.v2.json" });
    permlang(".", "lock", "src", "--lock", "permlang.lock.v2.json");
    const { code, out } = permlang(".", "check", "src", "--lock", "permlang.lock.v2.json", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain(
      "permlang.lock.v2.json:1:1 error PERM005: This change stops checking with permlang.lock.json, which the base commit's workflow checks with, and this check reads permlang.lock.v2.json instead.",
    );
    // The comment says so too.
    const md = permlang(".", "diff", base, "src", "--lock", "permlang.lock.v2.json", "--format", "markdown").out;
    expect(md).toContain("**This pull request stops checking with <code>permlang.lock.json</code>**");
    // Without --base, nothing is known of the base, as before.
    expect(permlang(".", "check", "src", "--lock", "permlang.lock.v2.json").code).toBe(0);
  });

  it("fails a change that runs the Action in a folder with no lock at the base", () => {
    app("app");
    workflow("permlang.yml", { "working-directory": "app", args: "src" });
    permlang("app", "lock", "src");
    const base = commit("base");
    // Moved to a new folder, with a lock of its own.
    git("mv", "app", "app2");
    app("app2", "api.data-broker.example");
    workflow("permlang.yml", { "working-directory": "app2", args: "src" });
    permlang("app2", "lock", "src");
    const { code, out } = permlang("app2", "check", "src", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain("This change stops checking with app/permlang.lock.json");
  });

  it("fails a change to a lock file the base has but doesn't check with", () => {
    // A lock file added earlier, unused, and then switched to.
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    app(".", "api.data-broker.example");
    permlang(".", "lock", "src", "--lock", "spare.json");
    app(".");
    const base = commit("base");
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --lock spare.json" });
    expect(permlang(".", "check", "src", "--lock", "spare.json", "--base", base)).toMatchObject({ code: 1, out: expect.stringContaining("stops checking with permlang.lock.json") });
  });

  it("finds the base's lock in any workflow, and in PermLang's own repository's `uses: ./`", () => {
    write("action.yml", "name: PermLang\nruns:\n  using: composite\n  steps: []\n");
    app(".");
    workflow("self.yml", { uses: "./", args: "src --lock checked.json" });
    permlang(".", "lock", "src", "--lock", "checked.json");
    const base = commit("base");
    // Renamed workflow, other lock.
    rmSync(path.join(dir, ".github", "workflows", "self.yml"));
    workflow("renamed.yml", { uses: "./", args: "src --lock other.json" });
    permlang(".", "lock", "src", "--lock", "other.json");
    expect(permlang(".", "check", "src", "--lock", "other.json", "--base", base).out).toContain("stops checking with checked.json");
  });

  it("takes permlang.lock.json in this folder as the base's lock when the base's workflows don't say", () => {
    app(".");
    // No workflow, or one whose inputs come from an expression (here, what --lock names isn't the lock).
    workflow("matrix.yml", { args: "${{ matrix.args }} --lock unused.json" });
    permlang(".", "lock", "src");
    permlang(".", "lock", "src", "--lock", "unused.json");
    const base = commit("base");
    permlang(".", "lock", "src", "--lock", "other.json");
    expect(permlang(".", "check", "src", "--lock", "other.json", "--base", base).out).toContain("stops checking with permlang.lock.json");
    expect(permlang(".", "check", "src", "--base", base).code).toBe(0);
  });

  it("lets a monorepo add a package, and move a lock in two steps", () => {
    app("web");
    workflow("permlang.yml", { "working-directory": "web", args: "src" });
    permlang("web", "lock", "src");
    const base = commit("base");
    // A new package, with its own step and lock: the base's lock is still checked with.
    app("api");
    workflow("permlang.yml", { "working-directory": "web", args: "src" }, { "working-directory": "api", args: "src" });
    permlang("api", "lock", "src");
    expect(permlang("api", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    expect(permlang("web", "check", "src", "--base", base)).toMatchObject({ code: 0 });

    // Moving web's lock: first a step that reads the new one next to the old...
    workflow("permlang.yml", { "working-directory": "web", args: "src" }, { "working-directory": "web", args: "src --lock next.json" });
    permlang("web", "lock", "src", "--lock", "next.json");
    expect(permlang("web", "check", "src", "--lock", "next.json", "--base", base)).toMatchObject({ code: 0 });
    const both = commit("both");
    // ...then, once that's merged, dropping the old one.
    workflow("permlang.yml", { "working-directory": "web", args: "src --lock next.json" });
    expect(permlang("web", "check", "src", "--lock", "next.json", "--base", both)).toMatchObject({ code: 0 });
  });

  // A step that never ran still counted as reading the base's lock, so a pull request could point
  // the real check at a lock of its own and add a decoy (GHSA-h4jc-gqvh-2675). Only a step that
  // runs whenever its workflow runs for a pull request, and whose failure fails its job, counts.
  const step = "      - uses: PermLang/permlang@v0\n        with:\n          args: src\n";
  const job = (extra = "") => `jobs:\n  decoy:\n    runs-on: ubuntu-latest\n${extra}    steps:\n`;
  it.each([
    ["a step with if:", `on: pull_request\n${job()}      - if: false\n        uses: PermLang/permlang@v0\n        with:\n          args: src\n`],
    ["a job with if:", `on: pull_request\n${job("    if: false\n")}${step}`],
    ["a job that needs one with if:", `on: pull_request\njobs:\n  never:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n  decoy:\n    needs: never\n    runs-on: ubuntu-latest\n    steps:\n${step}`],
    ["a step whose failure doesn't fail its job", `on: pull_request\n${job()}      - uses: PermLang/permlang@v0\n        continue-on-error: true\n        with:\n          args: src\n`],
    ["a job whose failure doesn't fail the run", `on: pull_request\n${job("    continue-on-error: true\n")}${step}`],
    ["a job whose if: only starts with always()", `on: pull_request\n${job("    if: always() && github.event_name == 'push'\n")}${step}`],
    ["a job that runs always but whose failure doesn't fail the run", `on: pull_request\n${job("    if: always()\n    continue-on-error: true\n")}${step}`],
    ["a workflow that doesn't run for pull requests", `on: push\n${job()}${step}`],
    ["a workflow that runs only for some pull requests", `on:\n  pull_request:\n    paths: [nothing/**]\n${job()}${step}`],
  ])("doesn't count %s as still reading the base's lock", (_, decoy) => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --lock permlang.lock.v2.json" });
    write(".github/workflows/decoy.yml", decoy);
    permlang(".", "lock", "src", "--lock", "permlang.lock.v2.json");
    expect(permlang(".", "check", "src", "--lock", "permlang.lock.v2.json", "--base", base)).toMatchObject({ code: 1, out: expect.stringContaining("stops checking with permlang.lock.json") });
  });

  it.each([
    ["on: pull_request", "on: pull_request\n"],
    ["a list of events", "on: [push, pull_request]\n"],
    ["a mapping of events", "on:\n  push:\n  pull_request:\n"],
    ["an empty pull_request mapping", "on:\n  pull_request: {}\n"],
  ])("counts a step that runs for every pull request, with %s", (_, on) => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    workflow("permlang.yml", { args: "src --lock next.json" });
    write(".github/workflows/old.yml", `${on}${job()}${step}`);
    permlang(".", "lock", "src", "--lock", "next.json");
    expect(permlang(".", "check", "src", "--lock", "next.json", "--base", base)).toMatchObject({ code: 0 });
  });

  // A check's job that needs the job installing the dependencies has `if: always()`, so it runs,
  // and fails, when that job fails: skipped, it would count as passed (GHSA-86ff-3f4h-rrjp). It
  // runs whatever the jobs it needs do, so it surely runs.
  const never = "  never:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: \"true\"\n";
  const needsNever = (condition: string) => `on: pull_request\njobs:\n${never}  check:\n    needs: never\n    if: ${condition}\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
  it.each([
    ["a job with if: always() that needs one that never runs", needsNever("always()")],
    ["a job with if: ${{ always() }}", needsNever("${{ always() }}")],
    ["a job with if: !cancelled()", needsNever('"!cancelled()"')],
    ["a job with if: ${{ !cancelled() }}", needsNever("${{ !cancelled() }}")],
    ["a step with if: always()", `on: pull_request\n${job()}      - if: always()\n        uses: PermLang/permlang@v0\n        with:\n          args: src\n`],
  ])("counts %s as still reading the base's lock", (_, old) => {
    app(".");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    const base = commit("base");
    workflow("permlang.yml", { args: "src --lock next.json" });
    write(".github/workflows/old.yml", old);
    permlang(".", "lock", "src", "--lock", "next.json");
    expect(permlang(".", "check", "src", "--lock", "next.json", "--base", base)).toMatchObject({ code: 0 });
  });

  it("ignores other Actions, and steps it can't read", () => {
    app(".");
    workflow("permlang.yml", { args: "src" }, { uses: "someone/permlang@v1", args: "--lock elsewhere.json" }, { args: "src --frob" });
    permlang(".", "lock", "src");
    permlang(".", "lock", "src", "--lock", "elsewhere.json");
    const base = commit("base");
    expect(permlang(".", "check", "src", "--base", base)).toMatchObject({ code: 0 });
    // Another Action's --lock isn't a lock PermLang checks with, and neither is a local Action that isn't there.
    workflow("permlang.yml", { args: "src --lock elsewhere.json" }, { uses: "someone/permlang@v1", args: "--lock elsewhere.json" }, { uses: "./nowhere", args: "--lock permlang.lock.json" });
    expect(permlang(".", "check", "src", "--lock", "elsewhere.json", "--base", base).out).toContain("stops checking with permlang.lock.json");
  });

  // With the base's lock at another path, `args: src --no-lock` turned the comparison off without
  // touching any lock file the base has.
  it("fails a change that stops checking with any lock file", () => {
    app(".");
    workflow("permlang.yml", { args: "src --lock locks/app.json" });
    mkdirSync(path.join(dir, "locks"));
    permlang(".", "lock", "src", "--lock", "locks/app.json");
    const base = commit("base");
    app(".", "api.data-broker.example");
    workflow("permlang.yml", { args: "src --no-lock" });
    const { code, out } = permlang(".", "check", "src", "--no-lock", "--base", base);
    expect(code).toBe(1);
    expect(out).toContain("error PERM005: This change stops checking with locks/app.json, which the base commit's workflow checks with. A lock file the base doesn't check with");
    // The comment says so too, and names no lock file read instead.
    const md = permlang(".", "diff", base, "src", "--no-lock", "--format", "markdown").out;
    expect(md).toContain("**This pull request stops checking with <code>locks/app.json</code>**, which the base commit's workflow checks with. A lock file");
    // Neither commit has permlang.lock.json, so everything is new; but the change deletes no lock file.
    expect(md).toContain("There's no <code>permlang.lock.json</code> at the base commit, so everything is listed as new.");
    expect(md).not.toContain("deletes");
    expect(JSON.parse(permlang(".", "diff", base, "src", "--no-lock", "--lock", "locks/app.json", "--json").out)).toMatchObject({ lockMoved: ["locks/app.json"] });
  });

  it("counts the base's lock file as left behind when the change deletes the workflows", () => {
    app(".");
    workflow("permlang.yml", { args: "src --lock checked.json" });
    permlang(".", "lock", "src", "--lock", "checked.json");
    const base = commit("base");
    rmSync(path.join(dir, ".github"), { recursive: true });
    permlang(".", "lock", "src", "--lock", "other.json");
    expect(permlang(".", "check", "src", "--lock", "other.json", "--base", base)).toMatchObject({ code: 1, out: expect.stringContaining("stops checking with checked.json") });
  });

  // A workflow committed before its lock file, as in a project adopting PermLang in two steps.
  it("leaves out a lock file the base's workflow names but the base doesn't have", () => {
    app(".");
    workflow("permlang.yml", { args: "src --lock planned.json" });
    const base = commit("workflow first");
    workflow("permlang.yml", { args: "src" });
    permlang(".", "lock", "src");
    expect(permlang(".", "check", "src", "--base", base)).toMatchObject({ code: 0 });
  });

  it("is a usage error when the base isn't a commit here", () => {
    app(".");
    permlang(".", "lock", "src");
    commit("base");
    expect(permlang(".", "check", "src", "--base", "1".repeat(40))).toMatchObject({ code: 2, out: expect.stringMatching(/isn't a commit in this repository; fetch it first/) });
  });
});

describe("the lock files a workflow's PermLang steps read", () => {
  const files: Record<string, string> = {
    ".github/workflows/many.yml": [
      "on: pull_request",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: PermLang/permlang@v0", // no inputs: permlang.lock.json at the root
      "      - uses: permlang/PERMLANG@0123456789abcdef0123456789abcdef01234567", // names are case-insensitive
      "        with: { working-directory: web }",
      "      - uses: PermLang/permlang/sub@v0",
      "        with: { working-directory: api, args: src --lock locks/api.json }",
      "      - uses: PermLang/permlang@v0",
      "        with: { working-directory: off, args: src --no-lock }", // reads none
      "      - uses: PermLang/permlang@v0",
      "        with: { args: src --lock /etc/permlang.lock.json }", // outside the repository
      "      - uses: PermLang/permlang@v0",
      "        with: { args: src --lock C:/locks/permlang.lock.json }",
      "      - uses: PermLang/permlang@v0",
      "        with: { args: \"${{ matrix.args }}\" }", // can't be told
      "      - uses: PermLang/permlang@v0",
      "        with: { args: src --frob }", // the check would stop
      "      - uses: someone/permlang@v1",
      "        with: { args: --lock other.json }", // another Action
      "      - uses: ./tools/permlang", // a local Action named PermLang
      "        with: { args: --lock tools.json }",
      "      - uses: ./tools/yaml-only", // its action.yaml, when there's no action.yml
      "        with: { args: --lock yaml.json }",
      "      - uses: ./tools/other", // a local Action with another name
      "        with: { args: --lock other.json }",
      "      - uses: ./tools/missing", // a local Action that isn't there
      "        with: { args: --lock missing.json }",
      "",
    ].join("\n"),
    ".github/workflows/broken.yml": "jobs: [\n",
    "tools/permlang/action.yml": "name: PermLang\n",
    "tools/yaml-only/action.yaml": "name: PermLang\n",
    "tools/other/action.yml": "name: Other\n",
  };
  const read = (file: string) => files[file];

  it("finds each step's lock from its working-directory and --lock, and leaves out the ones it can't tell", () => {
    const workflows = [".github/workflows/many.yml", ".github/workflows/broken.yml", ".github/workflows/gone.yml"];
    expect([...locksRead(workflows, read)].sort()).toEqual(["api/locks/api.json", "permlang.lock.json", "tools.json", "web/permlang.lock.json", "yaml.json"]);
  });

  it("reads each PermLang step's inputs as written", () => {
    const steps = permLangSteps([".github/workflows/many.yml"], read);
    expect(steps.slice(0, 3)).toEqual([
      { workingDirectory: undefined, args: undefined, surelyRuns: true },
      { workingDirectory: "web", args: undefined, surelyRuns: true },
      { workingDirectory: "api", args: "src --lock locks/api.json", surelyRuns: true },
    ]);
    expect(steps).toHaveLength(10);
  });
});
