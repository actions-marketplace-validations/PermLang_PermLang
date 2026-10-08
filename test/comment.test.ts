// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// The permission-diff comment the Action posts, and the text diff, as the second round of
// verification found them: what stays when the comment is cut to fit GitHub's limit, text
// from the code that could still change the comment, and what the comment says about lock
// files a change stops using or never had.

import { describe, expect, it } from "vitest";
import { COMMENT_LIMIT, SUMMARY_LIMIT, commentMarker, formatDiffMarkdown, formatDiffText, formatNoLock, NO_LOCK_STATUS } from "../src/diff.js";
import { diffLocks, type LockFile } from "../src/lock.js";

const lock = (functions: Record<string, string[]>): LockFile => ({ permlang: 2, functions, unsafe: {} });
const empty = lock({});

// The summary line names each kind of change. When it would only name the one section right
// below it, as for a lock upgraded from format 1 (only settings are new), it said it twice.
describe("the comment's summary line", () => {
  const settings = lock({ "permlang.config.json#<permlang.config.json>": ["permlang.files(src)", "permlang.strictness(development)"] });
  const unchecked = lock({ "permlang.config.json#<unchecked>": ["unchecked.package(leftpad2)"] });

  it("is left out when it would only repeat the one section's heading", () => {
    for (const head of [settings, unchecked]) {
      const md = formatDiffMarkdown(diffLocks(empty, head), {});
      expect(md.match(/Check settings changed|New code PermLang can't check/g)).toHaveLength(1);
    }
  });

  it("stays when it says more than the heading below it", () => {
    const both = lock({ ...settings.functions, "src/a.ts#run": ["exec"] });
    const md = formatDiffMarkdown(diffLocks(empty, both), {});
    expect(md).toContain("**1 function gains access** · **Check settings changed**");
  });
});

describe("the comment, cut to fit", () => {
  // 400 long flow rules took the whole comment, and the new exec was left out (gate verifier, A(a)).
  it("puts the new-access table before the settings changes", () => {
    const rules = Array.from({ length: 400 }, (_, i) => `permlang.flow(env(SECRET_${i}_${"X".repeat(120)}) -> net(host${i}.example))`);
    const head = lock({ "permlang.config.json#<permlang.config.json>": rules, "src/a.ts#run": ["exec"] });
    const md = formatDiffMarkdown(diffLocks(empty, head), {});
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(md).toContain("| <code>+ exec</code> |");
    expect(md.indexOf("| New access |")).toBeLessThan(md.indexOf("**Check settings changed.**"));
    expect(md).toMatch(/\*\*Cut short\*\*/);
  });

  // One 70,000-character path hid every other new access, the data broker included (A(b), item 2).
  it("clips each cell, so one long capability can't push the others out", () => {
    const head = lock({ "src/a.ts#read": [`fs.read(/tmp/${"a".repeat(70_000)})`], "src/b.ts#send": ["net(api.data-broker.example)", "exec"] });
    const md = formatDiffMarkdown(diffLocks(empty, head), {});
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(md).toContain("<code>+ net(api.data-broker.example)</code>");
    expect(md).toContain("<code>+ exec</code>");
    expect(md).toContain(`<code>+ fs.read(/tmp/${"a".repeat(400)}`);
    expect(md).not.toContain("a".repeat(600));
    expect(md).not.toMatch(/Cut short/);
  });

  it("clips every kind of cell: names, files, reasons, paths, settings, and tools", () => {
    const long = "n".repeat(5_000);
    const head: LockFile = {
      permlang: 2,
      functions: { [`src/${long}.ts#${long}`]: [`net(${long})`], "permlang.config.json#<permlang.config.json>": [`permlang.files(${long})`] },
      unsafe: { [`src/${long}.ts#${long}`]: long },
    };
    const md = formatDiffMarkdown(diffLocks(empty, head), { [`src/${long}.ts#${long}`]: { [`net(${long})`]: [long, long] } }, { aiTools: { [`net(${long})`]: [long] } });
    expect(md).not.toContain("n".repeat(501));
    for (const line of md.split("\n")) expect(line.length).toBeLessThan(5_000);
  });

  it("skips a row that doesn't fit, keeps the rows after it, and counts what it left out", () => {
    // Twenty functions with long names make one row far longer than the others.
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/big.ts#${"f".repeat(450)}${i}`, ["net(big.example)"]]));
    const head = lock({ ...big, "src/z.ts#late": ["net(zz.example)"] });
    const md = formatDiffMarkdown(diffLocks(empty, head), {}, {}, 6_000);
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(6_000);
    expect(md).not.toContain("<code>+ net(big.example)</code>");
    expect(md).toContain("<code>+ net(zz.example)</code>");
    expect(md).toContain("1 more line isn't shown");
  });

  it("names at most 20 AI tools and capabilities in one row", () => {
    const tools = Array.from({ length: 50 }, (_, i) => `tool${i}`);
    const md = formatDiffMarkdown(diffLocks(empty, lock({ "src/a.ts#f": ["exec"] })), {}, { aiTools: { exec: tools } });
    expect(md.match(/<code>tool\d+<\/code>/g)).toHaveLength(20);
    expect(md).toContain("and 30 more");
  });

  // The job summary was the same cut body, while the note said it had the full diff (A(c)).
  it("fits far more in a job summary, and says where the rest is when even that is cut", () => {
    const many = lock(Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`src/f${i}.ts#f`, [`net(host${i}.example)`]])));
    const comment = formatDiffMarkdown(diffLocks(empty, many), {});
    const summary = formatDiffMarkdown(diffLocks(empty, many), {}, {}, SUMMARY_LIMIT);
    expect(comment).toMatch(/Cut short/);
    expect(summary).not.toMatch(/Cut short/);
    expect(summary.split("\n").filter((l) => l.startsWith("| <code>+ net("))).toHaveLength(3_000);
    expect(comment).toContain("The job summary has the full diff");
    const hugeSummary = formatDiffMarkdown(diffLocks(empty, lock(Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`src/f${i}.ts#f`, [`net(host${i}.example)`]])))), {}, {}, SUMMARY_LIMIT);
    expect(Buffer.byteLength(hugeSummary, "utf8")).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(hugeSummary).toContain("to fit GitHub's limit on job summary size");
    expect(hugeSummary).not.toContain("The job summary has the full diff");
  });
});

describe("text from the code in the comment", () => {
  // U+202E, BEL, ESC and NUL reached the comment raw (gate verifier, D).
  it("shows control and bidirectional characters as escapes", () => {
    const evil = "net(a\u202eexe.b\u0007\u001b[31m\u0000x)";
    const head: LockFile = { permlang: 2, functions: { "src/a.ts#f": [evil] }, unsafe: { "src/a.ts#f": "why\u202e\u0007" } };
    const md = formatDiffMarkdown(diffLocks(empty, head), { "src/a.ts#f": { [evil]: ["f", "run(\u001b)"] } });
    expect(md).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(md).toContain("&#92;u202e");
  });
});

describe("the comment's marker", () => {
  // `.web/` and `web/` shared a marker, so their runs replaced each other's comment (E).
  it("keeps a folder's leading dot", () => {
    expect(commentMarker(".web")).toBe("<!-- permlang-diff: .web -->");
    expect(commentMarker("./web")).toBe("<!-- permlang-diff: web -->");
    expect(commentMarker(".")).toBe("<!-- permlang-diff -->");
    expect(commentMarker("./")).toBe("<!-- permlang-diff -->");
    expect(commentMarker(".github/x")).toBe("<!-- permlang-diff: .github/x -->");
    expect(commentMarker("..")).toBe("<!-- permlang-diff: .. -->");
  });
});

describe("lock files the comment speaks of", () => {
  // A pull request could point the Action at a new lock file, and the comment said only that the
  // base had no such file (item 1).
  it("says when the change stops checking with the base commit's lock file", () => {
    const md = formatDiffMarkdown(diffLocks(undefined, lock({ "src/a.ts#f": ["exec"] })), {}, { lockFile: "permlang.lock.v2.json", baseMissing: true, lockMoved: ["permlang.lock.json"] });
    expect(md).toContain("**This pull request stops checking with <code>permlang.lock.json</code>**");
    expect(md).toContain("reads <code>permlang.lock.v2.json</code> instead");
    const text = formatDiffText(diffLocks(undefined, lock({ "src/a.ts#f": ["exec"] })), {}, { lockFile: "permlang.lock.v2.json", lockMoved: ["permlang.lock.json"] });
    expect(text).toContain("This change stops checking with permlang.lock.json, which the base commit's workflow checks with, and reads permlang.lock.v2.json instead.");
  });

  // `args: src --no-lock`, when the base's lock isn't at the default path: nothing is read instead.
  it("doesn't name a lock file read instead when the check reads none", () => {
    const notes = { lockMoved: ["locks/app.json"], enforced: false };
    const md = formatDiffMarkdown(diffLocks(empty, lock({ "src/a.ts#f": ["exec"] })), {}, notes);
    expect(md).toContain("**This pull request stops checking with <code>locks/app.json</code>**, which the base commit's workflow checks with. A lock file");
    expect(md).not.toContain("instead");
    const text = formatDiffText(diffLocks(empty, lock({ "src/a.ts#f": ["exec"] })), {}, notes);
    expect(text).toContain("This change stops checking with locks/app.json, which the base commit's workflow checks with. With --base");
    expect(text).not.toContain("instead");
  });

  // An adoption pull request that deleted its own new lock left the earlier comment standing (F).
  it("has a notice for no lock file at all, which the Action recognizes", () => {
    const md = formatNoLock("permlang.lock.json", commentMarker("packages/api"));
    expect(md.split("\n")[0]).toBe("<!-- permlang-diff: packages/api -->");
    expect(md).toContain("There's no <code>permlang.lock.json</code> in this pull request or at its base commit");
    expect(md.split("\n").at(-1)).toBe(NO_LOCK_STATUS);
  });
});

describe("what the comment lists besides new access", () => {
  const unchecked = "permlang.config.json#<unchecked>";

  it("lists code PermLang could check before and can't now, and code it now can, with where when that's known", () => {
    const base = lock({ [unchecked]: ["unchecked.package(left-pad)"] });
    const head = lock({ [unchecked]: ["unchecked.import(src/x.cjs)", "unchecked.package(leftpad2)"] });
    const via = { [unchecked]: { "unchecked.import(src/x.cjs)": ["src/app.ts:3"] } };
    const md = formatDiffMarkdown(diffLocks(base, head), via);
    // A zero-width space after the colon keeps GitHub from reading "app.ts:3" as anything else.
    expect(md).toContain("- <code>+ src/x.cjs</code>: an import with no types, in src/app.ts:\u200b3\n");
    // With no record of where, the row just ends.
    expect(md).toContain("- <code>+ leftpad2</code>: a package with no adapter\n");
    expect(md).toContain("<details><summary>Removed access</summary>\n\n- <code>- left-pad</code>: no longer a package with no adapter");
    const text = formatDiffText(diffLocks(base, head), { [unchecked]: { "unchecked.package(leftpad2)": ["src/app.ts:7"] } });
    expect(text).toContain("  + leftpad2: a package with no adapter, called in src/app.ts:7");
    expect(text).toContain("  + src/x.cjs: an import with no types\n");
    expect(text).toContain("  - left-pad: no longer a package with no adapter");
  });

  it("shows an override's old value when it had one", () => {
    const override = { name: "lodash", version: "4.17.21", section: "overrides" as const, dev: false, change: "override" as const, target: "lodash", known: "adapter" as const, installed: false };
    const changed = formatDiffMarkdown(diffLocks(empty, empty), {}, { dependencies: [{ ...override, previous: "4.17.20" }] });
    expect(changed).toContain("| <code>&#126; lodash</code> 4.17.20 → 4.17.21 <sub>(overrides)</sub> | **Overridden**: installed at this version wherever <code>lodash</code> is in the dependency tree |");
    expect(formatDiffMarkdown(diffLocks(empty, empty), {}, { dependencies: [override] })).toContain("| <code>&#126; lodash</code> → 4.17.21 <sub>(overrides)</sub> |");
    expect(formatDiffText(diffLocks(empty, empty), {}, { dependencies: [{ ...override, previous: "4.17.20" }] })).toContain("  ~ lodash 4.17.20 -> 4.17.21 (overrides): overridden");
    expect(formatDiffText(diffLocks(empty, empty), {}, { dependencies: [override] })).toContain("  ~ lodash -> 4.17.21 (overrides): overridden");
  });
});

describe("the text diff", () => {
  // It said "The base and the code reach the same access" about code it couldn't analyze (C).
  it("says the code wasn't analyzed when it couldn't be", () => {
    const text = formatDiffText(diffLocks(empty, empty), {}, { analysisError: "Strictness must be one of: sketch, development, production." });
    expect(text).toContain("The lock files show no permission changes, but the code wasn't analyzed.");
    expect(text).not.toContain("reach the same access");
  });
});

// A capability an adapter names `constructor` (a name CAPABILITY_NAME allows) read Object's own
// `constructor` from the notes and the paths, and the diff threw "function is not iterable".
describe("names that objects have already", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("are only names, in the comment and the text (%s)", (name) => {
    const changes = diffLocks(empty, lock({ [`src/a.ts#${name}`]: [name, "net"] }));
    expect(() => formatDiffMarkdown(changes, {}, { aiTools: {} })).not.toThrow();
    expect(() => formatDiffText(changes, {}, { aiTools: {} })).not.toThrow();
    expect(formatDiffMarkdown(changes, {}, { aiTools: {} })).not.toContain("AI model");
    expect(formatDiffText(changes, {}, {})).toContain(`+ ${name}`);
  });
});
