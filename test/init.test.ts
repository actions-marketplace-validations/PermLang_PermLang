// `permlang init`: the day-one setup for an existing project. Runs the CLI in a
// temporary directory.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  return runCli(args, { cwd: dir });
}

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
    expect(steps("pnpm-lock.yaml")).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(steps("yarn.lock")).toContain("yarn install --ignore-scripts");
    expect(steps()).toContain("npm install --ignore-scripts");
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
