// Project configuration in the lock: GitHub workflows, composite Actions, and package.json
// scripts. AI agents edit these as readily as code, and a new `permissions: write-all`, secret,
// or postinstall hook is a bigger change than most functions, so each is recorded and reviewed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { buildLock } from "../src/lock.js";
import { projectFiles } from "../src/project-files.js";

const PIN = "3d3c42e5aac5ba805825da76410c181273ba90b1";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-project-"));
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    path.join(dir, ".github", "workflows", "release.yml"),
    [
      "name: Release",
      "on:",
      "  release:",
      "    types: [published]",
      "  pull_request_target:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: write",
      "      id-token: write",
      "    steps:",
      `      - uses: actions/checkout@${PIN} # v7.0.1`,
      "      - uses: actions/setup-node@v7",
      "      - run: npm publish",
      "        env:",
      "          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "  notify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: ./.github/actions/notify",
      "        with:",
      "          webhook: ${{ secrets['SLACK_WEBHOOK'] }}",
      "  reuse:",
      "    uses: org/shared/.github/workflows/deploy.yml@main",
      "    secrets: inherit",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, ".github", "workflows", "lint.yaml"), "on: [push, pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  writeFileSync(path.join(dir, ".github", "workflows", "broken.yml"), "on: [push\njobs: {\n");
  writeFileSync(
    path.join(dir, "action.yml"),
    ["name: Thing", "runs:", "  using: composite", "  steps:", "    - uses: actions/cache/restore@v6", "      with:", "        key: x"].join("\n"),
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "app", scripts: { test: "vitest run", postinstall: "node scripts/setup.js" }, dependencies: {} }, null, 2),
  );
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name: string) => projectFiles(dir).find((f) => f.name === name)!;

describe("project configuration", () => {
  it("records a workflow's triggers, permissions per job, secrets, and Actions", () => {
    expect(entry("<release.yml>").actual).toEqual([
      "ci.action(./.github/actions/notify)",
      "ci.action(actions/checkout)",
      "ci.action(actions/setup-node)",
      "ci.action(org/shared/.github/workflows/deploy.yml)",
      "ci.permission(contents: read)",
      "ci.permission(contents: write)",
      "ci.permission(id-token: write)",
      "ci.secret(NPM_TOKEN)",
      "ci.secret(SLACK_WEBHOOK)",
      "ci.secret(inherit)",
      "ci.trigger(pull_request_target)",
      "ci.trigger(release)",
      "ci.unpinned(actions/setup-node)",
      "ci.unpinned(org/shared/.github/workflows/deploy.yml)",
    ]);
  });

  it("uses the workflow's permissions for jobs that don't set their own, and 'default' when neither does", () => {
    // `notify` and `reuse` inherit contents: read from the workflow; `publish` sets its own.
    expect(entry("<release.yml>").actual).not.toContain("ci.permission(default)");
    // Without a permissions block anywhere, the token gets the repository's default, which can be write-all.
    expect(entry("<lint.yaml>").actual).toEqual(["ci.permission(default)", "ci.trigger(pull_request)", "ci.trigger(push)"]);
  });

  it("points each capability at the line that grants it", () => {
    const release = entry("<release.yml>");
    expect(release.sites["ci.permission(contents: write)"]!.line).toBe(12);
    expect(release.sites["ci.secret(NPM_TOKEN)"]!.line).toBe(19);
    expect(release.sites["ci.unpinned(actions/setup-node)"]!.line).toBe(16);
    expect(release.sites["ci.trigger(pull_request_target)"]!.line).toBe(5);
    expect(release.via["ci.unpinned(actions/setup-node)"]).toEqual(["uses: actions/setup-node@v7"]);
  });

  it("records a composite Action's steps", () => {
    expect(entry("<action.yml>").actual).toEqual(["ci.action(actions/cache/restore)", "ci.unpinned(actions/cache/restore)"]);
  });

  it("records package.json scripts with their commands, at their lines", () => {
    const pkg = entry("<package.json>");
    expect(pkg.actual).toEqual(["npm.script(postinstall: node scripts/setup.js)", "npm.script(test: vitest run)"]);
    expect(pkg.sites["npm.script(postinstall: node scripts/setup.js)"]!.line).toBe(5);
  });

  it("can't read a broken workflow, and says so instead of passing it", () => {
    expect(entry("<broken.yml>").actual).toEqual(["ci.unverifiable"]);
  });

  it("marks every entry as configuration, keyed by file", () => {
    const files = projectFiles(dir);
    expect(files.every((f) => f.kind === "config" && f.line === 1 && !f.annotated)).toBe(true);
    expect(files.map((f) => path.relative(dir, f.file).replaceAll("\\", "/")).sort()).toEqual([
      ".github/workflows/broken.yml",
      ".github/workflows/lint.yaml",
      ".github/workflows/release.yml",
      "action.yml",
      "package.json",
    ]);
  });

  it("finds nothing in a folder without configuration", () => {
    expect(projectFiles(path.join(dir, ".github"))).toEqual([]);
  });
});

describe("project configuration in the check", () => {
  const code = () => {
    const file = path.join(dir, "app.ts");
    writeFileSync(file, "export const x = 1;\n");
    return [file];
  };
  const lockFile = () => path.join(dir, "permlang.lock.json");
  const recorded = () => buildLock(checkFiles(code(), { projectRoot: dir }), dir);

  it("records configuration in the lock, keyed by file", () => {
    expect(Object.keys(recorded().functions)).toEqual([
      ".github/workflows/broken.yml#<broken.yml>",
      ".github/workflows/lint.yaml#<lint.yaml>",
      ".github/workflows/release.yml#<release.yml>",
      "action.yml#<action.yml>",
      "package.json#<package.json>",
    ]);
  });

  it("fails on a new secret the lock doesn't record, at its line", () => {
    const lock = recorded();
    lock.functions[".github/workflows/release.yml#<release.yml>"] = lock.functions[".github/workflows/release.yml#<release.yml>"]!.filter((c) => c !== "ci.secret(NPM_TOKEN)");
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: lock } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005");
    expect(drift).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 19,
        capability: "ci.secret(NPM_TOKEN)",
        message: ".github/workflows/release.yml now grants ci.secret(NPM_TOKEN), which permlang.lock.json doesn't record.",
      }),
    ]);
  });

  it("only warns when the lock predates configuration, so upgrading doesn't fail the build", () => {
    const old = { permlang: 1 as const, functions: {}, unsafe: {} };
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: old } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005");
    expect(drift.length).toBeGreaterThan(5);
    expect(drift.every((d) => d.severity === "warning" && d.message.includes("doesn't record project configuration yet"))).toBe(true);
  });

  it("says a file no longer grants what the lock records", () => {
    const lock = recorded();
    lock.functions["action.yml#<action.yml>"]!.push("ci.secret(OLD_TOKEN)");
    const report = checkFiles(code(), { projectRoot: dir, lock: { file: lockFile(), contents: lock } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005").map((d) => `${d.severity} ${d.message}`)).toEqual([
      "warning action.yml no longer grants ci.secret(OLD_TOKEN), but permlang.lock.json still records it.",
    ]);
  });

  it("isn't recorded without a project root (the library default)", () => {
    expect(checkFiles(code()).functions.some((f) => f.kind === "config")).toBe(false);
  });
});
