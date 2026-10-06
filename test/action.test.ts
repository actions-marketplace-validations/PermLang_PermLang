// The GitHub Action's own scripts (action.yml), run with bash as the runner would, against a real
// git repository and a stand-in for the `gh` command. They decide whether the check requires the
// lock, and which comment the permission diff replaces, so they're tested like the rest
// (found in the code review: G3, G6, G12, A3, A4, A8).

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const repo = fileURLToPath(new URL("..", import.meta.url));
const action = parse(readFileSync(path.join(repo, "action.yml"), "utf8")) as { runs: { steps: { name: string; run?: string; with?: Record<string, string> }[] } };
const script = (name: string) => action.runs.steps.find((s) => s.name === name)!.run!;

/** Bash, as GitHub runs it: Git Bash on Windows (not WSL's bash.exe, which comes first on the PATH there). */
function findBash(): string | undefined {
  if (process.platform !== "win32") return "bash";
  const git = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const root = path.resolve(git, "..", "..", "..");
  return [path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe")].find(existsSync);
}
const bash = findBash();

let dir: string;
let work: string;
let temp: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-action-"));
  work = path.join(dir, "work");
  temp = path.join(dir, "temp");
  mkdirSync(temp);
  mkdirSync(path.join(work, "src"), { recursive: true });
  writeFileSync(path.join(work, "src", "app.ts"), 'export async function ping() {\n  return fetch("https://api.example.com/");\n}\n');
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  // `node` that runs PermLang from source, as the Action runs its build.
  writeFileSync(path.join(temp, "node"), `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" --import ${pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href} "$@"\n`);
  chmodSync(path.join(temp, "node"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();
}

function permlang(...args: string[]): void {
  execFileSync(process.execPath, [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repo, "src", "cli.ts"), ...args], { cwd: work, encoding: "utf8", stdio: "pipe" });
}

/** Runs one step's script; returns its exit code, output, and what it wrote to GITHUB_OUTPUT. */
function run(step: string, env: Record<string, string>, cwd = work): { code: number; out: string; outputs: Record<string, string>; summary: string } {
  const file = path.join(temp, "step.sh");
  writeFileSync(file, script(step));
  const outputFile = path.join(temp, `output-${Math.random()}`);
  const summaryFile = path.join(temp, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const result = spawnSync(bash!, ["--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(temp, "bin")}${path.delimiter}${process.env.PATH}`,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_WORKSPACE: work,
      RUNNER_TEMP: temp,
      NODE: path.join(temp, "node").replaceAll("\\", "/"),
      PERMLANG: path.join(repo, "src", "cli.ts"),
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}`, outputs, summary: readFileSync(summaryFile, "utf8") };
}

describe.skipIf(!bash)("the Action's base-commit lookup", () => {
  let origin: string;
  beforeEach(() => {
    // The repository's remote, where the base commit lives.
    origin = path.join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["-C", origin, "config", "uploadpack.allowAnySHA1InWant", "true"]);
    git("remote", "add", "origin", pathToFileURL(origin).href);
  });
  const base = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("push", "-q", "origin", "HEAD:refs/heads/main");
    return git("rev-parse", "HEAD");
  };

  it("requires the lock when the base commit has one, even after the pull request deletes it", () => {
    permlang("init", "src");
    const sha = base();
    rmSync(path.join(work, "permlang.lock.json"));
    const { code, outputs } = run("Look up the base commit", { ARGS: "src", BASE_SHA: sha });
    expect(code).toBe(0);
    expect(outputs).toMatchObject({ lock: "permlang.lock.json", fetched: "true", "base-has-lock": "true", "require-lock": "true", "sarif-category": "permlang" });
  });

  it("follows --lock in the arguments, and doesn't require a lock the base doesn't have", () => {
    const sha = base();
    const { outputs } = run("Look up the base commit", { ARGS: "src --lock locks/custom.json", BASE_SHA: sha });
    expect(outputs).toMatchObject({ lock: "locks/custom.json", fetched: "true", "base-has-lock": "false", "require-lock": "false" });
  });

  it("requires the lock, with a warning instead of a failure, when the base can't be fetched", () => {
    base();
    const { code, out, outputs } = run("Look up the base commit", { ARGS: "src", BASE_SHA: "0".repeat(40) });
    expect(code).toBe(0);
    expect(out).toContain("::warning::Couldn't fetch the base commit");
    expect(outputs).toMatchObject({ fetched: "false", "require-lock": "true" });
  });

  it("gives each folder its own code-scanning category", () => {
    const sha = base();
    mkdirSync(path.join(work, "packages", "api"), { recursive: true });
    expect(run("Look up the base commit", { ARGS: "", BASE_SHA: sha }, path.join(work, "packages", "api")).outputs["sarif-category"]).toBe("permlang/packages/api");
  });
});

describe.skipIf(!bash)("the Action's comment", () => {
  /** A stand-in for gh: answers from files, and logs what it was asked. */
  function fakeGh(options: { viewer?: string; comments?: string[]; patch?: number; post?: number }) {
    mkdirSync(path.join(temp, "bin"), { recursive: true });
    writeFileSync(path.join(temp, "comments.tsv"), (options.comments ?? []).map((c) => `${c}\n`).join(""));
    const gh = [
      "#!/bin/bash",
      `log="${path.join(temp, "gh.log").replaceAll("\\", "/")}"`,
      'echo "$*" >> "$log"',
      'input=""; prev=""; for a in "$@"; do [ "$prev" = "--input" ] && input="$a"; prev="$a"; done',
      'case "$*" in',
      `  *graphql*) ${options.viewer ? `echo "${options.viewer}"` : "exit 1"} ;;`,
      '  "api user"*) exit 1 ;;',
      `  *"--method PATCH"*) cp "$input" "${path.join(temp, "patched.json").replaceAll("\\", "/")}"; exit ${options.patch ?? 0} ;;`,
      `  *"--method POST"*) cp "$input" "${path.join(temp, "posted.json").replaceAll("\\", "/")}"; exit ${options.post ?? 0} ;;`,
      `  *comments*) cat "${path.join(temp, "comments.tsv").replaceAll("\\", "/")}" ;;`,
      "esac",
      "",
    ].join("\n");
    writeFileSync(path.join(temp, "bin", "gh"), gh);
    chmodSync(path.join(temp, "bin", "gh"), 0o755);
  }
  const sent = (what: "patched" | "posted") => {
    const file = path.join(temp, `${what}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { body: string }).body : undefined;
  };
  const env = (more: Record<string, string> = {}) => ({
    BASE_SHA: git("rev-parse", "HEAD"),
    PR_NUMBER: "7",
    REPO: "acme/app",
    HEAD_REPO: "acme/app",
    ARGS: "src",
    STRICTNESS: "",
    LOCK: "permlang.lock.json",
    FETCHED: "true",
    BASE_HAS_LOCK: "true",
    ...more,
  });

  beforeEach(() => {
    permlang("init", "src");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(work, "src", "app.ts"), 'export async function ping() {\n  return fetch("https://data-broker.example/");\n}\n');
  });

  it("posts a new comment, passing the body in a file", () => {
    fakeGh({});
    const { code, summary } = run("Comment the permission diff", env());
    expect(code).toBe(0);
    expect(sent("posted")).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff/);
    expect(sent("posted")).toContain("<code>+ net(data-broker.example)</code>");
    expect(summary).toContain("<code>+ net(data-broker.example)</code>");
  });

  it("updates only its own comment: this token's account, this folder's marker", () => {
    fakeGh({
      comments: [
        "101\tmallory\t<!-- permlang-diff -->", // anyone can post the marker
        "102\tgithub-actions[bot]\t<!-- permlang-diff: packages/web -->", // another folder's run
        "103\tgithub-actions[bot]\t<!-- permlang-diff -->",
      ],
    });
    expect(run("Comment the permission diff", env()).code).toBe(0);
    expect(readFileSync(path.join(temp, "gh.log"), "utf8")).toContain("--method PATCH repos/acme/app/issues/comments/103 --input");
    expect(sent("patched")).toContain("<code>+ net(data-broker.example)</code>");
  });

  it("finds a personal token's own comment, and never another account's", () => {
    fakeGh({ viewer: "alice", comments: ["201\tgithub-actions[bot]\t<!-- permlang-diff -->", "202\talice\t<!-- permlang-diff -->"] });
    run("Comment the permission diff", env());
    expect(readFileSync(path.join(temp, "gh.log"), "utf8")).toContain("issues/comments/202");
  });

  it("fails the step when its comment can't be updated, since the old one would look current", () => {
    fakeGh({ comments: ["103\tgithub-actions[bot]\t<!-- permlang-diff -->"], patch: 1 });
    const { code, out } = run("Comment the permission diff", env());
    expect(code).toBe(1);
    expect(out).toContain("::error::Couldn't update the permission diff comment");
  });

  it("only warns when a new comment can't be posted", () => {
    fakeGh({ post: 1 });
    const { code, out } = run("Comment the permission diff", env());
    expect(code).toBe(0);
    expect(out).toContain("::warning::Couldn't post the permission diff comment");
  });

  it("leaves a fork's pull request the job summary, since its token can't comment", () => {
    fakeGh({});
    const { code, out, summary } = run("Comment the permission diff", env({ HEAD_REPO: "someone/fork" }));
    expect(code).toBe(0);
    expect(out).toContain("::notice::Pull request from a fork");
    expect(summary).toContain("PermLang permission diff");
    expect(existsSync(path.join(temp, "gh.log"))).toBe(false);
  });

  it("says when the pull request deletes the lock, instead of leaving quietly", () => {
    fakeGh({});
    rmSync(path.join(work, "permlang.lock.json"));
    expect(run("Comment the permission diff", env()).code).toBe(0);
    expect(sent("posted")).toContain("This pull request deletes <code>permlang.lock.json</code>");
  });

  it("replaces the comment with a notice when the diff can't be computed", () => {
    fakeGh({ comments: ["103\tgithub-actions[bot]\t<!-- permlang-diff -->"] });
    const { code, out } = run("Comment the permission diff", env({ BASE_SHA: "1".repeat(40) }));
    expect(code).toBe(0);
    expect(out).toContain("::warning::Couldn't compute the permission diff");
    expect(sent("patched")).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff\n\n> \[!CAUTION\]\n> \*\*PermLang couldn't compute the permission diff\*\*/);
  });

  it("reads the lock --lock names", () => {
    fakeGh({});
    git("mv", "permlang.lock.json", "custom.json");
    git("commit", "-q", "-m", "custom lock");
    expect(run("Comment the permission diff", env({ ARGS: "src --lock custom.json", LOCK: "custom.json", BASE_SHA: git("rev-parse", "HEAD") })).code).toBe(0);
    expect(sent("posted")).toContain("<code>+ net(data-broker.example)</code>");
  });

  it("does nothing when neither the pull request nor its base has a lock", () => {
    fakeGh({});
    rmSync(path.join(work, "permlang.lock.json"));
    const { code, out } = run("Comment the permission diff", env({ BASE_HAS_LOCK: "false" }));
    expect(code).toBe(0);
    expect(out).toContain("No lock file here or at the base commit");
    expect(existsSync(path.join(temp, "gh.log"))).toBe(false);
  });
});

describe("the Action's setup", () => {
  const step = (name: string) => action.runs.steps.find((s) => s.name === name)!;

  // actions/setup-node puts its Node first on the PATH for the rest of the job, and its
  // package-manager cache fails in some monorepos (found in the code review, A5).
  it("doesn't cache the package manager, and runs PermLang by its Node's full path", () => {
    expect(step("Set up Node").with).toMatchObject({ "package-manager-cache": false });
    expect(script("Check permissions")).toContain('"$NODE" "$PERMLANG" check');
    expect(script("Comment the permission diff")).toContain('"$NODE" "$PERMLANG" diff');
  });

  // On Windows, Git Bash's /d/a/... path named a folder that doesn't exist (A8).
  it("gives the build cache a Windows path on Windows", () => {
    expect(script("Compute build cache key")).toContain('cygpath -m "$(pwd -P)"');
  });
});
