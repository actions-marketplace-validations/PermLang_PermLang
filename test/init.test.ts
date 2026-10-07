// `permlang init`: the day-one setup for an existing project. Runs the CLI in a
// temporary directory.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runCli } from "./run-cli.js";
import { removeTemporary } from "./temporary.js";

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

afterEach(() => removeTemporary(dir));

describe("permlang init", () => {
  it("writes a sketch config and a lock, and the check then passes", () => {
    const { code, out } = permlang("init", "src");
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.config.json"), "utf8"))).toEqual({ strictness: "sketch" });
    // The lock also records what was checked, and with which settings.
    expect(JSON.parse(readFileSync(path.join(dir, "permlang.lock.json"), "utf8")).functions).toEqual({
      "permlang.config.json#<permlang.config.json>": ["permlang.files(src)", "permlang.strictness(sketch)", "permlang.tools(warn)", "permlang.unmapped(warn)"],
      "src/app.ts#ping": ["net(api.example.com)"],
    });
    expect(out).toMatch(/Next steps/);
    // Sketch still fails on anything the lock doesn't record, so init mustn't say nothing fails.
    expect(out).toContain("anything the lock file doesn't record still fails: new access, a changed setting, or new code PermLang can't check");
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

// The workflow init writes, as the second verification found it: options left out, so the first
// pull request failed or the gate stopped comparing; dependencies installed where the project
// isn't; names YAML read as something else; and two folders sharing one workflow file.
describe("permlang init --workflow", () => {
  /** The PermLang step's inputs, and the workflow's name, as GitHub reads the file. */
  const read = (file: string) => {
    const workflow = parse(readFileSync(path.join(dir, ".github", "workflows", file), "utf8")) as {
      name: string;
      jobs: { permissions: { steps: { uses?: string; run?: string; "working-directory"?: string; with?: Record<string, string> }[] } };
    };
    const steps = workflow.jobs.permissions.steps;
    return { name: workflow.name, inputs: steps.find((s) => s.uses?.startsWith("PermLang/"))!.with ?? {}, install: steps.filter((s) => s.run && /install|npm ci/.test(s.run) && !s.run.includes("corepack")).at(-1)! };
  };
  /** The check the Action runs, with the workflow's args split on spaces as it splits them. */
  const actionCheck = (inputs: Record<string, string>) => runCli(["check", ...(inputs.args ?? "").split(/\s+/).filter(Boolean)], { cwd: path.join(dir, inputs["working-directory"] ?? ".") });

  it("passes --lock, --config, --adapter, and --unmapped on in the workflow's args, so the first pull request passes", () => {
    git("init", "-q");
    writeFileSync(path.join(dir, "acme.json"), JSON.stringify({ permlang: 1, package: "acme", functions: {} }));
    const { code, out } = permlang("init", "src", "--lock", "perm.lock.json", "--config", "cfg.json", "--adapter", "acme.json", "--unmapped", "trust", "--workflow");
    expect(code).toBe(0);
    expect(out).toContain("Wrote perm.lock.json");
    const { inputs } = read("permlang.yml");
    expect(inputs.args).toBe("src --config cfg.json --adapter acme.json --unmapped trust --lock perm.lock.json");
    expect(actionCheck(inputs)).toMatchObject({ code: 0 });
  });

  it("writes paths relative to the folder it runs in, and refuses ones the Action can't read", () => {
    git("init", "-q");
    permlang("init", path.join(dir, "src"), "--workflow");
    expect(read("permlang.yml").inputs.args).toBe("src");
    rmSync(path.join(dir, ".github"), { recursive: true });
    for (const lock of ["../outside.json", path.join(tmpdir(), "elsewhere.json")]) {
      const { code, out } = permlang("init", "src", "--lock", lock, "--workflow");
      expect(code).toBe(2);
      expect(out).toMatch(/outside the repository/);
    }
    const { code, out } = permlang("init", "src", "--config", "${{secrets.X}}.json", "--workflow");
    expect(code).toBe(2);
    expect(out).toMatch(/GitHub reads it as an expression/);
  });

  // The repository root is found with its links resolved, so a path written another way (through a
  // link, or a Windows short name such as RUNNER~1, as on GitHub's Windows runners) must be too.
  it("reads a path given through a link to the folder as inside the repository", () => {
    git("init", "-q");
    const link = `${dir}-link`;
    symlinkSync(dir, link, "junction");
    try {
      const { code, out } = permlang("init", path.join(link, "src"), "--lock", path.join(link, "new.lock.json"), "--workflow");
      expect(out).not.toMatch(/outside the repository/);
      expect(code).toBe(0);
      expect(read("permlang.yml").inputs.args).toBe("src --lock new.lock.json");
    } finally {
      unlinkSync(link);
    }
  });

  it("quotes names YAML would read as something else", () => {
    git("init", "-q");
    for (const folder of ["packages/@acme/api", "#x", "[a]", "my app", "1e3"]) {
      mkdirSync(path.join(dir, folder, "src"), { recursive: true });
      writeFileSync(path.join(dir, folder, "src", "app.ts"), "export function ok() { return 1; }\n");
      expect(runCli(["init", "src", "--workflow"], { cwd: path.join(dir, folder) }).code).toBe(0);
    }
    const files = readdirSync(path.join(dir, ".github", "workflows"));
    const folders = files.map((f) => read(f).inputs["working-directory"]).sort();
    expect(folders).toEqual(["#x", "1e3", "[a]", "my app", "packages/@acme/api"]);
    expect(files.map((f) => read(f).name)).toContain("PermLang (packages/@acme/api)");
  });

  it("gives two folders that would share a workflow file one each", () => {
    git("init", "-q");
    for (const folder of ["packages/web", "packages_web"]) {
      mkdirSync(path.join(dir, folder, "src"), { recursive: true });
      writeFileSync(path.join(dir, folder, "src", "app.ts"), "export function ok() { return 1; }\n");
      const { code, out } = runCli(["init", "src", "--workflow"], { cwd: path.join(dir, folder) });
      expect(code).toBe(0);
      expect(out).toMatch(/Wrote .*\.github\/workflows\/permlang-packages-web/);
    }
    const files = readdirSync(path.join(dir, ".github", "workflows")).sort();
    expect(files).toHaveLength(2);
    expect(files.map((f) => read(f).inputs["working-directory"]).sort()).toEqual(["packages/web", "packages_web"]);
    // Run again, each finds its own.
    expect(runCli(["init", "src", "--workflow"], { cwd: path.join(dir, "packages_web") }).out).toMatch(/Kept .*permlang-packages-web/);
    expect(readdirSync(path.join(dir, ".github", "workflows"))).toHaveLength(2);
  });

  it("installs dependencies where the nearest lockfile is", () => {
    git("init", "-q");
    const backend = path.join(dir, "backend");
    mkdirSync(path.join(backend, "src"), { recursive: true });
    writeFileSync(path.join(backend, "src", "app.ts"), "export function ok() { return 1; }\n");
    writeFileSync(path.join(backend, "package.json"), "{}\n");
    writeFileSync(path.join(backend, "package-lock.json"), "{}\n");
    expect(runCli(["init", "src", "--workflow"], { cwd: backend }).code).toBe(0);
    expect(read("permlang-backend.yml").install).toEqual({ run: "npm ci --ignore-scripts --no-audit --no-fund", "working-directory": "backend" });
    // With no lockfile, where the nearest package.json is.
    rmSync(path.join(dir, ".github"), { recursive: true });
    rmSync(path.join(backend, "package-lock.json"));
    runCli(["init", "src", "--workflow"], { cwd: backend });
    expect(read("permlang-backend.yml").install).toEqual({ run: "npm install --ignore-scripts --no-audit --no-fund", "working-directory": "backend" });
  });

  it("counts functions and configuration entries apart", () => {
    // The settings alone, then the workflow too.
    expect(permlang("init", "src").out).toMatch(/Wrote permlang\.lock\.json: 1 function reaches something, across 1 file, and 1 configuration entry records the settings and project files\./);
    rmSync(path.join(dir, "permlang.lock.json"));
    const { out } = permlang("init", "src", "--workflow");
    expect(out).toMatch(/Wrote permlang\.lock\.json: 1 function reaches something, across 1 file, and 2 configuration entries record the settings and project files\./);
  });

  it("writes `.` for the folder it runs in", () => {
    git("init", "-q");
    expect(permlang("init", ".", "--workflow").code).toBe(0);
    const { inputs } = read("permlang.yml");
    expect(inputs.args).toBe(".");
    expect(actionCheck(inputs)).toMatchObject({ code: 0 });
  });

  it("refuses an --unmapped policy, or a path with a control character, before writing anything", () => {
    git("init", "-q");
    expect(permlang("init", "src", "--unmapped", "ignore", "--workflow")).toMatchObject({ code: 2, out: expect.stringMatching(/^"unmapped" must be one of: warn, error, trust\./) });
    const { code, out } = permlang("init", "src", "--lock", "x\u0007.json", "--workflow");
    expect(code).toBe(2);
    expect(out).toMatch(/^The GitHub Action can't be given a path with a line break or control character in it \("x\\u0007\.json"\)/);
    expect(existsSync(path.join(dir, "permlang.config.json"))).toBe(false);
    expect(existsSync(path.join(dir, ".github"))).toBe(false);
  });

  // GitHub's Windows runners name a drive the path can't be on. Linux has no such path.
  it.runIf(process.platform === "win32")("refuses a path on a drive that doesn't exist", () => {
    git("init", "-q");
    const drive = "QRSTUVWXYZ".split("").find((d) => !existsSync(`${d}:\\`));
    if (drive === undefined) return;
    const { code, out } = permlang("init", "src", "--lock", `${drive}:/locks/x.json`, "--workflow");
    expect(code).toBe(2);
    expect(out).toMatch(/is outside the repository/);
  });

  describe("with workflows already there", () => {
    /** A workflow with these steps, each its `uses:` and, optionally, its `with:`, in the repository's .github/workflows. */
    const workflow = (file: string, steps: [uses: string, inputs?: string][]) => {
      mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
      const lines = steps.flatMap(([uses, inputs]) => [`      - uses: ${uses}`, ...(inputs ? [`        with: ${inputs}`] : [])]);
      writeFileSync(path.join(dir, ".github", "workflows", file), ["on: pull_request", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", ...lines, ""].join("\n"));
    };
    const pkg = (folder: string) => {
      mkdirSync(path.join(dir, folder, "src"), { recursive: true });
      writeFileSync(path.join(dir, folder, "src", "app.ts"), "export function ok() { return 1; }\n");
      return path.join(dir, folder);
    };
    const hash = createHash("sha256").update("packages_web").digest("hex").slice(0, 8);

    it("keeps one it can't tell is another folder's", () => {
      git("init", "-q");
      const web = pkg("packages_web");
      // No PermLang step it can read (a local Action that isn't there), or a folder from an expression.
      for (const steps of [[["./tools/missing"]], [["PermLang/permlang@v0", "{ working-directory: \"${{ matrix.dir }}\" }"]]] as [string, string?][][]) {
        workflow("permlang-packages-web.yml", steps);
        const { code, out } = runCli(["init", "src", "--workflow"], { cwd: web });
        expect(code).toBe(0);
        expect(out).toContain("Kept ../.github/workflows/permlang-packages-web.yml.");
        expect(readdirSync(path.join(dir, ".github", "workflows"))).toEqual(["permlang-packages-web.yml"]);
        rmSync(path.join(web, "permlang.lock.json"));
      }
    });

    it("takes one that runs PermLang at the repository root as another folder's", () => {
      git("init", "-q");
      const web = pkg("packages_web");
      workflow("permlang-packages-web.yml", [["PermLang/permlang@v0"]]);
      expect(runCli(["init", "src", "--workflow"], { cwd: web }).out).toContain(`Wrote ../.github/workflows/permlang-packages-web-${hash}.yml`);
    });

    it("refuses, before writing anything, when other folders' workflows have both names", () => {
      git("init", "-q");
      const web = pkg("packages_web");
      workflow("permlang-packages-web.yml", [["PermLang/permlang@v0", "{ working-directory: packages/web }"]]);
      workflow(`permlang-packages-web-${hash}.yml`, [["PermLang/permlang@v0", "{ working-directory: packages-web }"]]);
      const { code, out } = runCli(["init", "src", "--workflow"], { cwd: web });
      expect(code).toBe(2);
      expect(out).toMatch(new RegExp(`^\\.github/workflows has workflows that run PermLang in other folders under both names this one would get \\(permlang-packages-web\\.yml, and with -${hash}\\)\\. Add a PermLang step for packages_web to one of them\\.`));
      expect(readdirSync(web)).toEqual(["src"]);
    });
  });
});
