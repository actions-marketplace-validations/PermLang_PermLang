// permlang.lock.json records what every function can reach. It is committed, so
// new access shows up as a change to the lock in the pull request's diff, and
// `permlang check` fails when the code and the lock disagree.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type Report } from "../src/check.js";
import { commentMarker, formatDiffMarkdown, formatDiffText } from "../src/diff.js";
import { buildLock, diffLocks, isConfigKey, lockDrift, parseLock, serializeLock, splitKey, type LockFile } from "../src/lock.js";
import { removeTemporary } from "./temporary.js";

const root = fileURLToPath(new URL("./strictness-fixtures/", import.meta.url));
const app = path.join(root, "app.ts");

const current = () => checkFiles([app], { strictness: "sketch" });
const lockDriftOf = (committed: LockFile, report: Report, text: string) => lockDrift(committed, buildLock(report, root), report, path.join(root, "permlang.lock.json"), text);

describe("lock file", () => {
  it("records each function's reach, keyed by file and name", () => {
    const lock = buildLock(current(), root);
    expect(lock).toEqual({
      permlang: 2,
      functions: {
        "app.ts#annotated": ["net(x.example)"],
        "app.ts#helper": ["net(helper.example)"],
        "app.ts#unannotated": ["net(helper.example)"],
      },
      unsafe: {},
    });
  });

  it("serializes stably, sorted, with a trailing newline", () => {
    const text = serializeLock(buildLock(current(), root));
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseLock(text, "permlang.lock.json")).toEqual(buildLock(current(), root));
    expect(serializeLock(parseLock(text, "x"))).toBe(text);
  });

  it("rejects a malformed lock file", () => {
    expect(() => parseLock("{", "permlang.lock.json")).toThrow(/permlang.lock.json/);
    expect(() => parseLock('{"permlang":3,"functions":{}}', "permlang.lock.json")).toThrow(/version 3 isn't one this PermLang reads/);
    expect(() => parseLock('{"permlang":2,"functions":[["net"]]}', "permlang.lock.json")).toThrow(/"functions" must be an object/);
    expect(() => parseLock('{"permlang":1,"functions":{"a#b":"net"}}', "permlang.lock.json")).toThrow(/a#b/);
  });

  // Access the lock records but the code doesn't reach used to be a warning, so a pull request
  // could approve access in advance by editing only the lock (found in the code review, G1).
  it("fails the check when the code and the lock differ either way, even in sketch", () => {
    const stale: LockFile = {
      permlang: 2,
      functions: { "app.ts#annotated": ["net(x.example)"], "app.ts#helper": ["net(helper.example)"], "app.ts#gone": ["exec"] },
      unsafe: {},
    };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: stale } });
    const drift = report.diagnostics.filter((d) => d.code === "PERM005").map((d) => `${d.severity} ${d.function} ${d.capability}`);
    expect(drift.sort()).toEqual(["error gone exec", "error unannotated net(helper.example)"]);
    // New access points at the line that reaches it (`return helper();`), not the function's first
    // line, so a pull-request annotation lands on the change.
    const added = report.diagnostics.find((d) => d.code === "PERM005" && d.capability === "net(helper.example)")!;
    expect(`${added.line}:${added.column}`).toBe("8:10");
  });

  it("points at the lock's own line for access only the lock has", () => {
    const lock = buildLock(current(), root);
    lock.functions["app.ts#helper"]!.push("exec");
    const text = serializeLock(lock);
    const report = checkFiles([app], { strictness: "sketch" });
    const [drift] = lockDriftOf(lock, report, text);
    expect(drift).toMatchObject({ severity: "error", file: path.join(root, "permlang.lock.json"), line: text.split("\n").findIndex((l) => l.includes('"exec"')) + 1 });
    expect(drift!.message).toBe("helper no longer reaches exec, but permlang.lock.json still records it.");
  });

  it("fails on a lock written by an older PermLang, with one error", () => {
    const old = { ...buildLock(current(), root), permlang: 1 as const };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: old } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005").map((d) => d.message)).toEqual([
      "permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.",
    ]);
  });

  // With two functions named helper, the second one's override replaced the first one's reviewed
  // reason under a single key, so the comment showed nothing new (found in the code review, G9).
  it("keys @perm-unsafe overrides like functions, so same-named functions keep their own", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "permlang-lock-"));
    try {
      const file = path.join(dir, "u.ts");
      writeFileSync(file, '/** @perm-unsafe reason:"first" */\nfunction helper() { return 1; }\n/** @perm-unsafe reason:"second" */\nfunction helper2() { return 2; }\nnamespace N {\n  /** @perm-unsafe reason:"third" */\n  export function helper() { return 3; }\n}\nexport { helper, helper2, N };\n');
      const again = buildLock(checkFiles([file]), dir);
      expect(again.unsafe).toEqual({ "u.ts#helper": "first", "u.ts#helper#2": "third", "u.ts#helper2": "second" });
    } finally {
      removeTemporary(dir);
    }
  });

  // A `#` in a file name made the key ambiguous (found in the code review, O5).
  it("keeps a file name with # or % apart from the function name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "permlang-lock-"));
    try {
      const file = path.join(dir, "we#ird%20.ts");
      writeFileSync(file, 'export function go() { return fetch("https://x.example/"); }\n');
      const lock = buildLock(checkFiles([file]), dir);
      expect(Object.keys(lock.functions)).toEqual(["we%23ird%2520.ts#go"]);
      expect(splitKey("we%23ird%2520.ts#go")).toEqual(["we#ird%20.ts", "go"]);
      expect(splitKey("src/a.ts#Class.#secret#2")).toEqual(["src/a.ts", "Class.#secret"]);
    } finally {
      removeTemporary(dir);
    }
  });

  it("passes when the lock matches", () => {
    const lock = buildLock(current(), root);
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: lock } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005")).toEqual([]);
  });
});

describe("permlang diff", () => {
  const base: LockFile = {
    permlang: 2,
    functions: { "src/leads.ts#handleLead": ["db.write(lead)", "email.send"], "src/old.ts#legacy": ["exec"] },
    unsafe: {},
  };
  const head: LockFile = {
    permlang: 2,
    functions: {
      "src/leads.ts#handleLead": ["db.write(lead)", "email.send", "env(BROKER_API_KEY)", "net(api.data-broker.io)"],
      "src/scoring.ts#scoreLead": ["env(BROKER_API_KEY)", "net(api.data-broker.io)"],
    },
    unsafe: { "src/render.ts#compile": "template compiler" },
  };

  it("lists what each function gains and loses", () => {
    const diff = diffLocks(base, head);
    expect(diff.functions).toEqual([
      { key: "src/leads.ts#handleLead", file: "src/leads.ts", name: "handleLead", status: "changed", added: ["env(BROKER_API_KEY)", "net(api.data-broker.io)"], removed: [] },
      { key: "src/old.ts#legacy", file: "src/old.ts", name: "legacy", status: "removed", added: [], removed: ["exec"] },
      { key: "src/scoring.ts#scoreLead", file: "src/scoring.ts", name: "scoreLead", status: "added", added: ["env(BROKER_API_KEY)", "net(api.data-broker.io)"], removed: [] },
    ]);
    expect(diff.unsafeAdded).toEqual([{ key: "src/render.ts#compile", reason: "template compiler" }]);
  });

  it("tells configuration entries from functions, whatever the file name's case or JSON flavor", () => {
    for (const key of [
      ".github/workflows/ci.yml#<ci.yml>",
      ".github/workflows/CI.YML#<CI.YML>",
      ".github/workflows/deploy.yaml#<deploy.yaml>",
      "packages/a/package.json5#<package.json5>",
      "package.json#<package.json>",
      "permlang.config.json#<permlang.config.json>",
      "tsconfig.json#<tsconfig.json>",
      "config/tsconfig.build.JSON#<tsconfig.build.JSON>",
    ]) {
      expect(isConfigKey(key), key).toBe(true);
    }
    for (const key of ["src/a.ts#<module>", "src/a.ts#<anonymous>", "src/a.ts#handler", "src/json.ts#parse.json"]) expect(isConfigKey(key), key).toBe(false);
  });

  it("treats a missing base lock as everything new", () => {
    expect(diffLocks(undefined, head).functions.every((f) => f.status === "added")).toBe(true);
  });

  it("formats a pull-request comment with the path to each new access", () => {
    const via = { "src/leads.ts#handleLead": { "net(api.data-broker.io)": ["scoreLead", 'axios.post("https://api.data-broker.io/v2/enrich", ...)'] } };
    const md = formatDiffMarkdown(diffLocks(base, head), via);
    expect(md).toContain("<!-- permlang-diff -->");
    expect(md).toContain("<code>handleLead</code>");
    expect(md).toContain("<code>+ net(api.data-broker.io)</code>");
    // A zero-width space after "https:" keeps GitHub from making a link of text from the code.
    expect(md).toContain("scoreLead → axios.post(&quot;https:\u{200b}//api.data-broker.io/v2/enrich&quot;, ...)");
    expect(md).toContain("<code>@perm-unsafe</code>");
    expect(md).toMatch(/2 functions gain access/);
  });

  // One logger with 1,750 callers made one table cell longer than GitHub allows a comment (G6).
  it("names at most 20 functions that can now reach a capability, and counts the rest", () => {
    const callers: LockFile = { permlang: 2, functions: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`src/f.ts#caller${i}`, ["net(log.example)"]])), unsafe: {} };
    const row = formatDiffMarkdown(diffLocks(undefined, callers), {}).split("\n").find((l) => l.startsWith("| <code>+ net(log.example)"))!;
    expect(row.match(/<code>caller\d+<\/code>/g)).toHaveLength(20);
    expect(row).toContain(", and 30 more |");
  });

  it("shows a changed @perm-unsafe reason, with the old one", () => {
    const changed: LockFile = { ...head, unsafe: { "src/render.ts#compile": "anything goes" } };
    const diff = diffLocks(head, changed);
    expect(diff.unsafeChanged).toEqual([{ key: "src/render.ts#compile", before: "template compiler", after: "anything goes" }]);
    expect(formatDiffMarkdown(diff, {})).toContain("- <code>src/render.ts#compile</code>: anything goes <sub>(was: template compiler)</sub>");
    expect(formatDiffMarkdown(diff, {})).toContain("**1 changed <code>@perm-unsafe</code> reason**");
    expect(formatDiffText(diff, {})).toBe("src/render.ts#compile\n  ~ @perm-unsafe: anything goes (was: template compiler)");
  });

  // Several Action runs on one pull request, one per package, replaced each other's comment
  // (found in the code review, G12).
  it("marks the comment with the folder it's for, when that isn't the repository root", () => {
    expect(commentMarker("")).toBe("<!-- permlang-diff -->");
    expect(commentMarker(".")).toBe("<!-- permlang-diff -->");
    expect(commentMarker("packages/api")).toBe("<!-- permlang-diff: packages/api -->");
    expect(commentMarker("packages\\my-app\\")).toBe("<!-- permlang-diff: packages/my%2Dapp -->");
    expect(commentMarker("a --> b")).toBe("<!-- permlang-diff: a%20%2D%2D%3E%20b -->");
    expect(formatDiffMarkdown(diffLocks(head, head), {}, { marker: commentMarker("packages/api") }).split("\n")[0]).toBe("<!-- permlang-diff: packages/api -->");
  });

  // Found in the second review: capability text went into the comment unescaped, so
  // `fs.read(/a\` | | |\n\n<!--)` could close the cell and open an HTML comment that
  // hides every row after it, along with the approval footer.
  it("escapes text from code, so a crafted capability can't hide rows", () => {
    const evil = "fs.read(/a` | | |\n\n<!--)";
    const sneaky: LockFile = {
      permlang: 2,
      functions: { "src/a.ts#f": [evil, "fs.read(/root/.ssh/id_rsa)"], "src/b.ts#g`|<x>": ["net"] },
      unsafe: { "src/c.ts#h": "reason with `backticks` | pipes <!-- and a comment" },
    };
    const md = formatDiffMarkdown(diffLocks(undefined, sneaky), { "src/a.ts#f": { [evil]: ["<!-- x", "a|b"] } });
    // Everything except PermLang's own marker and footer comes from code.
    const body = md.replace("<!-- permlang-diff -->", "").split("\n").filter((l) => !l.startsWith("<sub>Approving")).join("\n");
    expect(body).not.toContain("<!--");
    expect(body).not.toMatch(/`/);
    expect(md).toContain("fs.read(/root/.ssh/id&#95;rsa)"); // GitHub renders the entity as id_rsa
    expect(md).toContain("Approving this change approves the access above");
    // One table row per capability: the crafted one didn't break the table.
    const rows = md.split("\n").filter((l) => l.startsWith("| <code>+ "));
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.split(/(?<!\\)\|/).length).toBe(5);
  });

  it("says so when nothing changed", () => {
    expect(formatDiffMarkdown(diffLocks(head, head), {})).toContain("No permission changes");
    expect(formatDiffText(diffLocks(head, head), {})).toBe("No permission changes.");
  });
});

describe("reading and comparing locks", () => {
  const report = (r: Partial<Report>): Report => ({ files: 1, functions: [], units: [], diagnostics: [], unsafe: [], unmapped: [], unresolved: [], tools: [], ...r });

  it("reads a lock with no functions or overrides", () => {
    expect(parseLock('{"permlang":2}', "permlang.lock.json")).toEqual({ permlang: 2, functions: {}, unsafe: {} });
    expect(() => parseLock('{"functions":{}}', "permlang.lock.json")).toThrow(/version missing isn't one this PermLang reads/);
    expect(() => parseLock('{"permlang":2,"unsafe":{"a.ts#f":1}}', "permlang.lock.json")).toThrow('unsafe entry "a.ts#f" must be a reason string');
  });

  it("keys an override by its file and name when no function matches it", () => {
    const lock = buildLock(report({ unsafe: [{ file: path.join(root, "x.ts"), line: 3, function: "f", reason: "r" }] }), root);
    expect(lock.unsafe).toEqual({ "x.ts#f": "r" });
  });

  it("points at an override only the lock has, and at its key when the lock isn't laid out as PermLang writes it", () => {
    const committed: LockFile = { permlang: 2, functions: { "app.ts#gone": ["exec"] }, unsafe: { "app.ts#gone": "reviewed" } };
    const file = path.join(root, "permlang.lock.json");
    const text = serializeLock(committed);
    const drift = lockDrift(committed, buildLock(report({}), root), report({}), file, text);
    expect(drift.map((d) => `${d.line} ${d.message}`)).toEqual([
      `${text.split("\n").findIndex((l) => l.includes('"exec"')) + 1} gone no longer exists or reaches exec, but permlang.lock.json still records it.`,
      `${text.split("\n").findIndex((l) => l.includes('"reviewed"')) + 1} permlang.lock.json records a @perm-unsafe override on gone ("reviewed"), which the code no longer has.`,
    ]);
    // On one line, as a person might write it: the key's line.
    expect(lockDrift(committed, buildLock(report({}), root), report({}), file, JSON.stringify(committed)).map((d) => d.line)).toEqual([1, 1]);
  });
});

describe("the permission diff's notes", () => {
  const lock = (functions: Record<string, string[]>, unsafe: Record<string, string> = {}): LockFile => ({ permlang: 2, functions, unsafe });
  const base = lock({ "src/a.ts#f": ["net"], "src/b.ts#g": ["exec"] }, { "src/a.ts#f": "reviewed" });
  const head = lock({ "src/a.ts#f": ["net", "env(KEY)"] });
  const pending = diffLocks(lock({ "src/a.ts#f": ["net"] }), head);

  it("says when the base has no lock, or an old one", () => {
    const md = formatDiffMarkdown(diffLocks(undefined, head), {}, { baseMissing: true, baseOutdated: true });
    expect(md).toContain("<sub>There's no <code>permlang.lock.json</code> at the base commit, so everything is listed as new.</sub>");
    expect(md).toContain("written by an older PermLang, which didn't record check settings");
    expect(formatDiffText(diffLocks(undefined, head), {}, { baseMissing: true })).toContain("There's no permlang.lock.json at the base commit");
  });

  it("says when the working tree's lock is an old one, instead of what doesn't match", () => {
    const md = formatDiffMarkdown(diffLocks(base, head), {}, { lockOutdated: true, pending });
    expect(md).toContain("**<code>permlang.lock.json</code> was written by an older PermLang.**");
    expect(md).not.toContain("Not approved yet");
    expect(formatDiffText(diffLocks(base, base), {}, { lockOutdated: true })).toBe(
      "permlang.lock.json was written by an older PermLang: the check fails until `permlang lock` updates it.\n\nThe base and the code reach the same access.",
    );
  });

  it("doesn't say the check fails when it doesn't compare with the lock (--no-lock)", () => {
    expect(formatDiffMarkdown(diffLocks(base, head), {}, { pending, enforced: false })).toContain("The code and <code>permlang.lock.json</code> don't match. To approve");
    expect(formatDiffText(diffLocks(base, head), {}, { pending, enforced: false })).toContain("don't match. To approve");
    expect(formatDiffText(diffLocks(base, head), {}, { pending })).toContain("don't match, so the check fails.");
  });

  it("lists removed access and overrides, and shows how access is reached in text", () => {
    const diff = diffLocks(base, head);
    const md = formatDiffMarkdown(diff, {});
    expect(md).toContain("1 removed <code>@perm-unsafe</code> override");
    expect(md).toContain("- <code>src/a.ts#f</code>: <code>@perm-unsafe</code> removed");
    const text = formatDiffText(diff, { "src/a.ts#f": { "env(KEY)": ["f", "process.env.KEY"] } }, { aiTools: { "env(KEY)": ["lookup", "lookup"] } });
    expect(text).toContain("src/a.ts f\n  + env(KEY)  via f → process.env.KEY  (an AI model can trigger this: lookup)");
    expect(text).toContain("src/b.ts g (removed)\n  - exec");
    expect(text).toContain("src/a.ts#f\n  - @perm-unsafe");
  });

  it("shortens long text from the code", () => {
    const md = formatDiffMarkdown(diffLocks(undefined, lock({}, { "src/a.ts#f": "x".repeat(600) })), {});
    expect(md).toContain(`${"x".repeat(499)}…`);
    expect(md).not.toContain("x".repeat(500));
  });

  it("describes dependencies installed without scripts, and switched to another source", () => {
    const deps = [
      { name: "left-pad", version: "1.0.0", section: "dependencies" as const, dev: false, change: "added" as const, known: "unknown" as const, installed: true, installScripts: [] },
      { name: "lodash", version: "github:evil/lodash", previous: "^4.0.0", section: "dependencies" as const, dev: false, change: "source" as const, known: "pure" as const, installed: false },
    ];
    const md = formatDiffMarkdown(diffLocks(head, head), {}, { dependencies: deps });
    expect(md).toContain("**1 new dependency, 1 dependency from another source**");
    expect(md).toContain("| <code>+ left-pad</code> 1.0.0 | **Not checked**: no adapter | none |");
    expect(formatDiffMarkdown(diffLocks(head, head), {}, { dependencies: [deps[1]!] })).toContain("**1 dependency from another source**");
  });

  it("leaves out whole sections after a cut, and says how many lines", () => {
    const many = lock(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`src/f${i}.ts#f`, [`net(host${i}.example)`]])));
    const dependencies = [{ name: "late", version: "1.0.0", section: "dependencies" as const, dev: false, change: "added" as const, known: "unknown" as const, installed: false }];
    const md = formatDiffMarkdown(diffLocks(base, many), {}, { dependencies }, 8_000);
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(8_000);
    expect(md).not.toContain("late");
    expect(md).not.toContain("Removed access");
    const shown = md.split("\n").filter((l) => l.startsWith("| <code>+ net(")).length;
    // The rest of the table, the dependency table's 4 lines and row, and the removed-access block's 2 lines and 3 rows.
    expect(md).toContain(`${400 - shown + 5 + 5} more lines aren't shown`);
  });
});

describe("the scope the lock was written for", () => {
  it("fails, at the lock, when a check without settings compares with a lock that has them", () => {
    const committed: LockFile = { permlang: 2, functions: { "permlang.config.json#<permlang.config.json>": ["permlang.files(src)"] }, unsafe: {} };
    const report = checkFiles([app], { strictness: "sketch", lock: { file: path.join(root, "permlang.lock.json"), contents: committed } });
    expect(report.diagnostics.filter((d) => d.code === "PERM005")).toEqual([
      expect.objectContaining({ file: path.join(root, "permlang.lock.json"), line: 1, message: "This check ran on files it doesn't record, but permlang.lock.json was written for src." }),
    ]);
  });
});
