// `permlang init`: the day-one setup for an existing project. Runs the CLI in a
// temporary directory.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  return runCli(args, { cwd: dir });
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-init-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), `export async function ping() {\n  return fetch("https://api.example.com/");\n}\n`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("permlang init", () => {
  it("writes a sketch config and a lock, and the check then passes", () => {
    const { code, out } = permlang("init", "src");
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.config.json"), "utf8"))).toEqual({ strictness: "sketch" });
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.lock.json"), "utf8")).functions).toEqual({
      "src/app.ts#ping": ["net(api.example.com)"],
    });
    expect(out).toMatch(/Next steps/);
    // Sketch still fails on access the lock doesn't record, so init mustn't say nothing fails.
    expect(out).toContain("new access the lock file doesn't record still fails");
    expect(out).not.toMatch(/nothing fails/);
    expect(permlang("check", "src").code).toBe(0);
  });

  it("keeps an existing config", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), `{ "strictness": "production" }\n`);
    const { out } = permlang("init", "src");
    expect(readFileSync(path.join(dir, "permlang.config.json"), "utf8")).toBe(`{ "strictness": "production" }\n`);
    expect(out).toMatch(/Kept permlang\.config\.json/);
  });

  it("adds the GitHub workflow on request, with the same source selection", () => {
    permlang("init", "src", "--workflow");
    const workflow = readFileSync(path.join(dir, ".github", "workflows", "permlang.yml"), "utf8");
    expect(workflow).toContain("uses: PermLang/permlang@v0");
    expect(workflow).toContain("args: src");
    expect(workflow).toContain("pull-requests: write");
  });

  it("names the TypeScript project in the workflow when given one, and keeps a workflow that exists", () => {
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
    permlang("init", "--project", "tsconfig.json", "--workflow");
    const file = path.join(dir, ".github", "workflows", "permlang.yml");
    expect(readFileSync(file, "utf8")).toContain("args: --project tsconfig.json");
    writeFileSync(file, "# edited\n");
    expect(permlang("init", "--project", "tsconfig.json", "--workflow").out).toContain("Kept .github/workflows/permlang.yml.");
    expect(readFileSync(file, "utf8")).toBe("# edited\n");
  });

  it("rejects an unknown strictness", () => {
    const { code, out } = permlang("init", "src", "--strictness", "strict");
    expect(code).toBe(2);
    expect(out).toMatch(/^Strictness must be one of/);
  });

  // Without the dependencies' types, CI can't see file, process, or environment access (found
  // by the demo repository: its check passed while missing them).
  it("installs dependencies before checking, with the project's package manager", () => {
    const steps = (lockfile?: string) => {
      rmSync(path.join(dir, ".github"), { recursive: true, force: true });
      for (const f of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) rmSync(path.join(dir, f), { force: true });
      if (lockfile) writeFileSync(path.join(dir, lockfile), "");
      permlang("init", "src", "--workflow");
      return readFileSync(path.join(dir, ".github", "workflows", "permlang.yml"), "utf8");
    };
    const npm = steps("package-lock.json");
    expect(npm).toContain("uses: actions/setup-node@v7");
    expect(npm.indexOf("npm ci --ignore-scripts")).toBeGreaterThan(npm.indexOf("setup-node"));
    expect(npm.indexOf("PermLang/permlang@v0")).toBeGreaterThan(npm.indexOf("npm ci --ignore-scripts"));
    expect(npm).not.toContain("corepack");
    // Node 25 and later don't ship Corepack, so pnpm and Yarn install it from npm first.
    const pnpm = steps("pnpm-lock.yaml");
    expect(pnpm.indexOf("npm install --global corepack@latest")).toBeLessThan(pnpm.indexOf("corepack enable"));
    expect(pnpm.indexOf("corepack enable")).toBeLessThan(pnpm.indexOf("pnpm install --frozen-lockfile --ignore-scripts"));
    expect(steps("yarn.lock")).toContain("yarn install --frozen-lockfile --ignore-scripts");
    // Yarn 2 and later have no --ignore-scripts: they skip install scripts with --mode=skip-build.
    writeFileSync(path.join(dir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    const berry = steps("yarn.lock");
    expect(berry).toContain("npm install --global corepack@latest");
    expect(berry).toContain("yarn install --immutable --mode=skip-build");
    expect(berry).not.toContain("--ignore-scripts");
    expect(steps()).toContain("npm install --ignore-scripts");
  });

  it("records the workflow it writes in the lock, so the first pull request passes", () => {
    // A package.json script makes the lock record project configuration from the start.
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    expect(permlang("init", "src", "--workflow").code).toBe(0);
    const lock = JSON.parse(readFileSync(path.join(dir, "permlang.lock.json"), "utf8")) as { functions: Record<string, string[]> };
    expect(Object.keys(lock.functions)).toContain(".github/workflows/permlang.yml#<permlang.yml>");
    expect(permlang("check", "src")).toMatchObject({ code: 0 });
  });

  it("keeps an existing lock instead of approving whatever changed", () => {
    writeFileSync(path.join(dir, "permlang.lock.json"), `{ "permlang": 1, "functions": {}, "unsafe": {} }\n`);
    const { code, out } = permlang("init", "src");
    expect(code).toBe(0);
    expect(readFileSync(path.join(dir, "permlang.lock.json"), "utf8")).toBe(`{ "permlang": 1, "functions": {}, "unsafe": {} }\n`);
    expect(out).toContain("Kept permlang.lock.json.");
    expect(out).toContain("permlang lock");
  });

  it("refuses source paths the Action can't pass, before writing anything", () => {
    mkdirSync(path.join(dir, "my src"));
    const { code, out } = permlang("init", "my src", "--workflow");
    expect(code).toBe(2);
    expect(out).toMatch(/spaces/);
    expect(existsSync(path.join(dir, "permlang.config.json"))).toBe(false);
    expect(existsSync(path.join(dir, "permlang.lock.json"))).toBe(false);
  });

  it("writes Windows-style paths with forward slashes, for Linux runners", () => {
    permlang("init", ".\\src\\", "--workflow");
    expect(readFileSync(path.join(dir, ".github", "workflows", "permlang.yml"), "utf8")).toContain("args: src\n");
  });

  it("runs on the repository's default branch and in merge queues", () => {
    git("init", "-q");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    permlang("init", "src", "--workflow");
    const workflow = readFileSync(path.join(dir, ".github", "workflows", "permlang.yml"), "utf8");
    expect(workflow).toContain("    branches: [trunk]\n");
    expect(workflow).toContain("  merge_group:\n");
  });

  it("in a monorepo package, writes the workflow where GitHub reads it and runs in the package", () => {
    git("init", "-q");
    const pkg = path.join(dir, "packages", "api");
    mkdirSync(path.join(pkg, "src"), { recursive: true });
    writeFileSync(path.join(pkg, "src", "app.ts"), `export function ok() { return 1; }\n`);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    expect(runCli(["init", "src", "--workflow"], { cwd: pkg }).code).toBe(0);
    expect(existsSync(path.join(pkg, ".github"))).toBe(false);
    const workflow = readFileSync(path.join(dir, ".github", "workflows", "permlang-packages-api.yml"), "utf8");
    expect(workflow).toContain("working-directory: packages/api");
    expect(workflow).toContain("args: src");
    // Dependencies install at the repository root, where the workspace's lockfile is.
    expect(workflow).toContain("pnpm install --frozen-lockfile --ignore-scripts");
  });

  it("doesn't write the workflow unless asked", () => {
    permlang("init", "src");
    expect(existsSync(path.join(dir, ".github"))).toBe(false);
  });

  it("then fails the check when new access appears", () => {
    permlang("init", "src");
    writeFileSync(path.join(dir, "src", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    const { code, out } = permlang("check", "src");
    expect(code).toBe(1);
    expect(out).toMatch(/PERM005: ping can now reach net\(data-broker\.io\)/);
  });
});
