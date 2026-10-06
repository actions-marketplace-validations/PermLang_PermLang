// The review gate: a pull request mustn't be able to add access, or loosen the check, without the
// check failing and the comment showing it. Each case below is a way the code review found to get
// past it (G1–G10, O2, O3, O5). Runs the CLI in a temporary git repository, as the Action would.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, runCliStreams } from "./run-cli.js";

let dir: string;

function permlang(...args: string[]): { code: number; out: string } {
  return runCli(args, { cwd: dir, env: { GITHUB_WORKSPACE: dir } });
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

/** Writes a file under the temporary repository, creating its folder. */
function write(file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const lockJson = () => JSON.parse(read("permlang.lock.json")) as { permlang: number; functions: Record<string, string[]>; unsafe: Record<string, string> };
const writeLock = (lock: unknown) => write("permlang.lock.json", `${JSON.stringify(lock, null, 2)}\n`);
const ping = (host: string) => `export async function ping() {\n  return fetch("https://${host}/");\n}\n`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-gate-"));
  write("src/app.ts", ping("api.example.com"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the lock must match the code exactly (G1)", () => {
  it("fails when the lock records access the code doesn't reach, so it can't approve access in advance", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    // The pull request edits only the lock, adding exec to ping.
    const lock = lockJson();
    lock.functions["src/app.ts#ping"]!.push("exec");
    writeLock(lock);
    commit("pre-approve exec");

    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out).toContain("error PERM005: ping no longer reaches exec, but permlang.lock.json still records it.");
    expect(check.out).toContain("-> run `permlang lock`");

    const md = permlang("diff", "HEAD~1", "src", "--format", "markdown").out;
    expect(md).toContain("Not approved yet");
    expect(md).toContain("<code>- exec</code>");
    expect(md).toMatch(/permlang\.lock\.json.* records, but the code doesn't reach/);
    expect(md).not.toContain("No permission changes");
    expect(permlang("diff", "HEAD~1", "src").out).toContain("ping: exec");
  });

  it("passes once `permlang lock` has removed it", () => {
    expect(permlang("init", "src").code).toBe(0);
    const lock = lockJson();
    lock.functions["src/app.ts#ping"]!.push("exec");
    writeLock(lock);
    expect(permlang("lock", "src").code).toBe(0);
    expect(permlang("check", "src").code).toBe(0);
  });
});

describe("what gets checked is recorded in the lock (G2, G5)", () => {
  it("fails when tsconfig.json stops including a file, and shows it in the comment", () => {
    write("tsconfig.json", JSON.stringify({ include: ["src"] }));
    expect(permlang("init").code).toBe(0);
    commit("base");
    // The pull request moves new network access into a file it excludes from the project.
    write("tsconfig.json", JSON.stringify({ include: ["src"], exclude: ["src/hidden.ts"] }));
    write("src/hidden.ts", ping("evil.example"));

    const check = permlang("check");
    expect(check.code).toBe(1);
    expect(check.out).toContain("tsconfig.json now has exclude src/hidden.ts, which permlang.lock.json doesn't record.");
    const md = permlang("diff", "HEAD", "--format", "markdown").out;
    expect(md).toContain("Check settings changed");
    expect(md).toContain("<code>+ src/hidden.ts</code>");
  });

  it("follows extends to the files tsconfig.json really selects", () => {
    write("config/base.json", JSON.stringify({ include: ["../src"] }));
    write("tsconfig.json", JSON.stringify({ extends: "./config/base.json" }));
    expect(permlang("init").code).toBe(0);
    expect(lockJson().functions["tsconfig.json#<tsconfig.json>"]).toEqual(["tsconfig.include(src)"]);
    write("config/base.json", JSON.stringify({ include: ["../src"], exclude: ["../src/app.ts"] }));
    expect(permlang("check").out).toContain("tsconfig.json now has exclude src/app.ts");
  });

  it("fails, with one clear error, when the check runs on other files than the lock was written for", () => {
    expect(permlang("init", "src").code).toBe(0);
    write("tsconfig.json", JSON.stringify({ include: ["src"] }));
    const check = permlang("check");
    expect(check.code).toBe(1);
    const errors = check.out.split("\n").filter((l) => l.includes(" error "));
    expect(errors).toEqual([expect.stringContaining("PERM005: This check ran on --project tsconfig.json, but permlang.lock.json was written for src.")]);
    expect(permlang("check", "src").code).toBe(0);
  });

  it("fails when permlang.config.json loosens the check, and says how", () => {
    write("permlang.config.json", JSON.stringify({ strictness: "development" }));
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("permlang.config.json", JSON.stringify({ strictness: "sketch", unmapped: "trust" }));

    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out).toContain("The check runs with strictness sketch, but permlang.lock.json records strictness development.");
    expect(check.out).toContain("The check runs with unmapped: trust, but permlang.lock.json records unmapped: warn.");
    const md = permlang("diff", "HEAD", "src", "--format", "markdown").out;
    expect(md).toContain("Check settings changed");
    expect(md).toMatch(/strictness.*<code>sketch<\/code>, was <code>development<\/code>/);
  });

  it("records the settings the check really runs with, so a command-line option can't loosen it unseen", () => {
    expect(permlang("init", "src").code).toBe(0); // sketch, from the config init writes
    const check = permlang("check", "src", "--unmapped", "trust");
    expect(check.code).toBe(1);
    expect(check.out).toContain("The check runs with unmapped: trust (from --unmapped), but permlang.lock.json records unmapped: warn.");
    expect(check.out).toContain("--no-lock");
    // Recording the option makes it the reviewed setting.
    expect(permlang("lock", "src", "--unmapped", "trust").code).toBe(0);
    expect(permlang("check", "src", "--unmapped", "trust").code).toBe(0);
    expect(permlang("check", "src").code).toBe(1);
  });

  it("fails on a new adapter, and records each adapter's content", () => {
    write("node_modules/acme-sms/package.json", JSON.stringify({ name: "acme-sms", version: "1.0.0", types: "index.d.ts" }));
    write("node_modules/acme-sms/index.d.ts", "export declare function send(to: string, text: string): void;\n");
    write("src/alert.ts", `import { send } from "acme-sms";\nexport function alert() { send("+15550100", "hi"); }\n`);
    expect(permlang("init", "src").code).toBe(0);
    // The pull request declares the package pure, which hides what it does.
    write("acme-sms.json", JSON.stringify({ permlang: 1, package: "acme-sms", default: [] }));
    write("permlang.config.json", JSON.stringify({ strictness: "sketch", adapters: ["./acme-sms.json"] }));
    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out).toMatch(/The check runs with the adapter acme-sms\.json \(sha256:[0-9a-f]{16}\), which permlang\.lock\.json doesn't record\./);
    expect(permlang("lock", "src").code).toBe(0);
    // Editing the adapter changes its hash.
    write("acme-sms.json", JSON.stringify({ permlang: 1, package: "acme-sms", defines: ["sms.send"], default: [] }));
    expect(permlang("check", "src").code).toBe(1);
  });

  it("rejects a setting it doesn't know, rather than ignoring a typo", () => {
    write("permlang.config.json", JSON.stringify({ strictnes: "production" }));
    expect(permlang("check", "src", "--no-lock")).toEqual({ code: 2, out: 'permlang.config.json: unknown setting "strictnes". Settings: strictness, unmapped, tools, adapters, flows.\n' });
  });
});

describe("the lock can't be turned off (G3, G4)", () => {
  it("fails on configuration the lock doesn't record, whatever the lock looks like", () => {
    expect(permlang("init", "src").code).toBe(0);
    // A lock with no configuration entries used to mean "written before 0.3": warnings only.
    write(".github/workflows/ci.yml", "on: [pull_request_target]\npermissions: write-all\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ secrets.DEPLOY_KEY }}\n");
    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out).toContain("error PERM005: .github/workflows/ci.yml now grants ci.secret(DEPLOY_KEY)");
    expect(check.out).not.toContain("warning PERM005");
  });

  it("treats an explicit --lock that doesn't exist as a mistake", () => {
    expect(permlang("init", "src").code).toBe(0);
    expect(permlang("check", "src", "--lock", "permlang.lokc.json")).toEqual({ code: 2, out: "permlang.lokc.json doesn't exist. Run `permlang lock --lock permlang.lokc.json` to create it, or fix the path.\n" });
  });

  it("fails on a missing lock with --require-lock", () => {
    const check = permlang("check", "src", "--require-lock");
    expect(check.code).toBe(1);
    expect(check.out).toContain("error PERM005: permlang.lock.json is missing.");
    expect(permlang("check", "src").code).toBe(1); // PERM003 from development strictness, no lock needed
    expect(permlang("check", "src", "--no-lock", "--require-lock")).toEqual({ code: 2, out: "--no-lock and --require-lock can't be used together.\n" });
  });

  it("says in the comment when a pull request deletes the lock", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    rmSync(path.join(dir, "permlang.lock.json"));
    const md = permlang("diff", "HEAD", "src", "--format", "markdown");
    expect(md.code).toBe(0);
    expect(md.out).toContain("This pull request deletes <code>permlang.lock.json</code>");
    expect(md.out).not.toContain("No permission changes");
    expect(permlang("diff", "HEAD", "src").out).toContain("This change deletes permlang.lock.json");
  });

  it("fails on a lock written by an older PermLang with one error, and `permlang lock` updates it", () => {
    expect(permlang("init", "src").code).toBe(0);
    writeLock({ permlang: 1, functions: { "src/app.ts#ping": ["net(api.example.com)"] }, unsafe: {} });
    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out.split("\n").filter((l) => l.includes("PERM005"))).toEqual([
      "permlang.lock.json:1:1 error PERM005: permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.",
    ]);
    expect(permlang("lock", "src").code).toBe(0);
    expect(lockJson().permlang).toBe(2);
    expect(permlang("check", "src").code).toBe(0);
  });
});

describe("@perm-unsafe overrides are part of the lock (G9, G10)", () => {
  const helpers = (second: string) =>
    `/** @perm-unsafe reason:"reviewed: wraps the SDK" */\nfunction helper() { return 1; }\n${second}function helper2() { return 2; }\nexport const x = [helper, helper2];\n`;

  it("fails on a new, removed, or changed override until the lock records it", () => {
    write("src/u.ts", helpers(""));
    expect(permlang("init", "src").code).toBe(0);
    expect(lockJson().unsafe).toEqual({ "src/u.ts#helper": "reviewed: wraps the SDK" });

    write("src/u.ts", helpers(`/** @perm-unsafe reason:"trust me" */\n`));
    const added = permlang("check", "src");
    expect(added.code).toBe(1);
    expect(added.out).toContain('error PERM005: helper2 has a new @perm-unsafe override ("trust me"), which permlang.lock.json doesn\'t record.');

    write("src/u.ts", helpers("").replace("reviewed: wraps the SDK", "anything goes"));
    const changed = permlang("check", "src");
    expect(changed.code).toBe(1);
    expect(changed.out).toContain('helper\'s @perm-unsafe reason is now "anything goes", but permlang.lock.json records "reviewed: wraps the SDK".');
  });
});

describe("when the code can't be analyzed (G7)", () => {
  it("says so in every diff format, and never reports no changes", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("permlang.config.json", JSON.stringify({ strictness: "nope" }));
    expect(permlang("check", "src").code).toBe(2);

    const md = permlang("diff", "HEAD", "src", "--format", "markdown").out;
    expect(md).toContain("PermLang couldn't analyze the code");
    expect(md).toContain("Strictness must be one of");
    expect(md).not.toContain("No permission changes");
    const text = permlang("diff", "HEAD", "src").out;
    expect(text).toContain("Couldn't analyze the code");
    expect(text).not.toContain("No permission changes");
    const json = JSON.parse(permlang("diff", "HEAD", "src", "--format", "json").out) as { analysisError: string | null };
    expect(json.analysisError).toMatch(/Strictness must be one of/);
  });
});

describe("errors exit 2, not 1 (O2, O3, O5)", () => {
  it.each([
    [["check", "src", "--sarif", "no/such/folder/out.sarif", "--no-lock"], /^Can't write no\/such\/folder\/out\.sarif: /],
    [["check", "src", "--lock", "src"], /^Can't read src: /],
    [["check", "--project", "missing.json"], /^missing\.json doesn't exist\./],
  ])("exits 2 with a short message on %j", (args, message) => {
    const { code, out } = permlang(...args);
    expect(code).toBe(2);
    expect(out).toMatch(message);
    expect(out).not.toMatch(/\n\s+at /); // no stack trace
  });

  it("exits 2 on a malformed tsconfig.json", () => {
    write("tsconfig.json", "{ \"include\": [\"src\" ");
    const { code, out } = permlang("check");
    expect(code).toBe(2);
    expect(out).toMatch(/^tsconfig\.json: /);
  });

  it("reads a lock whose keys are named like Object's own properties", () => {
    expect(permlang("init", "src").code).toBe(0);
    const lock = lockJson();
    writeLock({ ...lock, functions: { ...lock.functions, toString: ["exec"], constructor: ["net"], __proto__: ["env"] } });
    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    expect(check.out).toContain("toString no longer exists or reaches exec");
  });

  it("regenerates a lock it can't read, with a warning", () => {
    write("permlang.lock.json", "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n");
    const lock = permlang("lock", "src");
    expect(lock.code).toBe(0);
    expect(lock.out).toContain("Couldn't read the old permlang.lock.json");
    expect(lockJson().functions["src/app.ts#ping"]).toEqual(["net(api.example.com)"]);
  });

  it("passes git refs after --end-of-options, so a ref can't be an option", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    const { code, out } = permlang("diff", "HEAD", "src", "--head", "--format=%H");
    expect(code).toBe(2);
    expect(out).toMatch(/^Can't read permlang\.lock\.json at --format=%H/);
    expect(out).not.toContain("not valid JSON");
  });

  it("prints valid JSON with --json and --github-annotations, and the annotations on standard error", () => {
    const { code, stdout, stderr } = runCliStreams(["check", "src", "--no-lock", "--json", "--github-annotations"], { cwd: dir, env: { GITHUB_WORKSPACE: dir } });
    expect(code).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toMatch(/^::error file=src\/app\.ts,line=2/m);
  });
});

describe("output from the code can't run workflow commands (O1)", () => {
  it("escapes line breaks in what `check` and `lock` print", () => {
    write("src/node.d.ts", "declare namespace NodeJS { interface ProcessEnv { [key: string]: string | undefined } }\ndeclare var process: { env: NodeJS.ProcessEnv };\n");
    write("src/env.ts", 'export function key() {\n  return process.env["A\\n::stop-commands::x\\u001b[2J"];\n}\n');
    const outputs = [permlang("check", "src", "--no-lock").out, permlang("lock", "src").out];
    for (const out of outputs) {
      expect(out.split(/\r?\n/).some((l) => l.trimStart().startsWith("::"))).toBe(false);
      expect(out).toContain("A\\n::stop-commands::x\\u001b[2J");
    }
    expect(existsSync(path.join(dir, "permlang.lock.json"))).toBe(true);
  });
});

describe("dependencies in the comment (G8, O2)", () => {
  it("lists optional and peer dependencies, a switch to another source, and survives odd versions", () => {
    write("package.json", JSON.stringify({ dependencies: { lodash: "^4.17.21" } }));
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("package.json", JSON.stringify({ dependencies: { lodash: "npm:evil-lodash@1.0.0", weird: 7 }, optionalDependencies: { "sketchy-telemetry": "1.0.0" }, peerDependencies: { react: "^19.0.0" } }));
    const md = permlang("diff", "HEAD", "src", "--format", "markdown");
    expect(md.code).toBe(0);
    expect(md.out).toContain("**3 new dependencies, 1 dependency from another source**");
    expect(md.out).toMatch(/<code>&#126; lodash<\/code> \^4\.17\.21 → npm:\u{200b}evil-lodash@\u{200b}1\.0\.0 \| \*\*Now installed from another source\*\*/u);
    expect(md.out).toContain("<code>+ sketchy-telemetry</code> 1.0.0 <sub>(optional)</sub>");
    expect(md.out).toContain("<code>+ react</code> ^19.0.0 <sub>(peer)</sub>");
    expect(md.out).toContain("<code>+ weird</code> 7 |");
    expect(permlang("diff", "HEAD", "src").out).toContain("~ lodash ^4.17.21 -> npm:evil-lodash@1.0.0: now installed from another source");
  });
});

describe("more of what the lock and the diff record", () => {
  it("fails when an override is removed, at the lock's line for it", () => {
    write("src/u.ts", '/** @perm-unsafe reason:"reviewed" */\nexport function helper() { return 1; }\n');
    expect(permlang("init", "src").code).toBe(0);
    write("src/u.ts", "export function helper() { return 1; }\n");
    const check = permlang("check", "src");
    expect(check.code).toBe(1);
    const line = read("permlang.lock.json").split("\n").findIndex((l) => l.includes('"reviewed"')) + 1;
    expect(check.out).toContain(`permlang.lock.json:${line}:1 error PERM005: permlang.lock.json records a @perm-unsafe override on helper ("reviewed"), which the code no longer has.`);
  });

  it("names a tsconfig.json option the lock doesn't record, and lists a change of checked files in the comment", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("tsconfig.json", JSON.stringify({ include: ["src"], compilerOptions: { baseUrl: "." } }));
    expect(permlang("lock").code).toBe(0);
    expect(permlang("check").code).toBe(0);
    const md = permlang("diff", "HEAD", "--format", "markdown").out;
    expect(md).toContain("- checked files: <code>+ --project tsconfig.json</code>");
    expect(md).toContain("- checked files: <code>- src</code>");
    write("tsconfig.json", JSON.stringify({ include: ["src"], compilerOptions: { baseUrl: "src" } }));
    expect(permlang("check").out).toContain("tsconfig.json now has baseUrl src, but permlang.lock.json records baseUrl .");
    write("tsconfig.json", JSON.stringify({ include: ["src"], compilerOptions: { baseUrl: ".", noLib: true } }));
    expect(permlang("check").out).toContain("tsconfig.json now has noLib true, which permlang.lock.json doesn't record.");
  });

  it("says in the comment which command-line option a setting came from", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    expect(permlang("lock", "src", "--unmapped", "trust").code).toBe(0);
    const md = permlang("diff", "HEAD", "src", "--unmapped", "trust", "--format", "markdown").out;
    expect(md).toContain("- unmapped: now <code>trust</code>, was <code>warn</code> <sub>(from <code>--unmapped</code>)</sub>");
    expect(permlang("diff", "HEAD", "src", "--unmapped", "trust").out).toContain("Check settings changed:\n  + permlang.config.json: permlang.unmapped(trust)\n  - permlang.config.json: permlang.unmapped(warn)");
  });

  it("shows the upgrade from an older lock as settings now recorded", () => {
    expect(permlang("init", "src").code).toBe(0);
    writeLock({ permlang: 1, functions: { "src/app.ts#ping": ["net(api.example.com)"] }, unsafe: {} });
    commit("an older PermLang's lock");
    const outdated = permlang("diff", "HEAD", "src", "--format", "markdown").out;
    expect(outdated).toContain("**<code>permlang.lock.json</code> was written by an older PermLang.**");
    expect(permlang("diff", "HEAD", "src").out).toContain("permlang.lock.json was written by an older PermLang: the check fails until `permlang lock` updates it.");
    expect(permlang("lock", "src").code).toBe(0);
    const md = permlang("diff", "HEAD", "src", "--format", "markdown").out;
    expect(md).toContain("written by an older PermLang, which didn't record check settings, so they're listed as new");
    expect(md).toContain("- strictness: <code>+ sketch</code>");
  });

  it("says when the base commit has no lock", () => {
    commit("before PermLang");
    expect(permlang("init", "src").code).toBe(0);
    const md = permlang("diff", "HEAD", "src", "--format", "markdown").out;
    expect(md).toContain("There's no <code>permlang.lock.json</code> at the base commit, so everything is listed as new.");
    expect(md).toContain("<code>+ net(api.example.com)</code>");
  });

  it("prints a comment that says so when the diff can't be computed, and exits 2", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    const { code, stdout, stderr } = runCliStreams(["diff", "f".repeat(40), "src", "--format", "markdown"], { cwd: dir, env: { GITHUB_WORKSPACE: dir } });
    expect(code).toBe(2);
    expect(stdout).toMatch(/^<!-- permlang-diff -->\n### PermLang permission diff\n\n> \[!CAUTION\]\n> \*\*PermLang couldn't compute the permission diff\*\*/);
    expect(stderr).toMatch(/^Can't read permlang\.lock\.json at f{40}: it isn't a commit in this repository/);
  });

  it("can't read a lock file outside the repository at a commit, and says why", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    const { code, out } = permlang("diff", "HEAD", "src", "--lock", "../outside.json");
    expect(code).toBe(2);
    expect(out).toMatch(/^Can't read \.\.\/outside\.json at HEAD: fatal: /);
  });

  it("marks the comment for the repository root outside GitHub Actions", () => {
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    const { out } = runCli(["diff", "HEAD", "src", "--format", "markdown"], { cwd: dir, env: { GITHUB_WORKSPACE: undefined } });
    expect(out.split("\n")[0]).toBe("<!-- permlang-diff -->");
  });

  it("survives a package.json that isn't an object, at the base or in the change", () => {
    write("package.json", "null\n");
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("package.json", JSON.stringify({ dependencies: { zod: "^3.0.0" } }));
    expect(permlang("diff", "HEAD", "src", "--format", "markdown").out).not.toContain("new dependenc");
    commit("an object");
    write("package.json", "7\n");
    const { code, out } = permlang("diff", "HEAD", "src", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).not.toContain("new dependenc");
  });

  it("still lists new dependencies, with the built-in adapters, when the settings can't be read", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("package.json", JSON.stringify({ dependencies: { stripe: "^22.0.0" } }));
    for (const config of [{ strictness: "sketch", adapters: ["./broken.json"] }, { strictness: "sketch", unmaped: "trust" }]) {
      write("broken.json", "{ not json");
      write("permlang.config.json", JSON.stringify(config));
      const md = permlang("diff", "HEAD", "src", "--format", "markdown").out;
      expect(md).toContain("PermLang couldn't analyze the code");
      expect(md).toMatch(/<code>\+ stripe<\/code> \^22\.0\.0 \| Checked by an adapter/);
    }
  });
});

describe("reading what isn't there", () => {
  it("leaves out dependencies when the change's package.json isn't JSON", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("package.json", '{ "dependencies": { "zod": ');
    const { code, out } = permlang("diff", "HEAD", "src", "--format", "markdown");
    expect(code).toBe(0);
    expect(out).not.toContain("new dependenc");
  });

  it("says why it can't read a commit when git can't run", () => {
    expect(permlang("init", "src").code).toBe(0);
    const { code, out } = runCli(["diff", "HEAD", "src"], { cwd: dir, env: { GITHUB_WORKSPACE: dir, PATH: "" } });
    expect(code).toBe(2);
    expect(out).toMatch(/^Can't read permlang\.lock\.json at HEAD: git can't be run \(.*ENOENT.*\)\./);
  });
});

describe("adapters in the dependency list", () => {
  it("describes a new package with the team's adapters, from the config file", () => {
    write("package.json", JSON.stringify({ dependencies: {} }));
    write("acme-sms.json", JSON.stringify({ permlang: 1, package: "acme-sms", default: [] }));
    write("permlang.config.json", JSON.stringify({ strictness: "sketch", adapters: ["./acme-sms.json"] }));
    expect(permlang("init", "src").code).toBe(0);
    commit("base");
    write("package.json", JSON.stringify({ dependencies: { "acme-sms": "1.0.0" } }));
    expect(permlang("diff", "HEAD", "src", "--format", "markdown").out).toContain("| <code>+ acme-sms</code> 1.0.0 | Declared pure |");
  });
});
