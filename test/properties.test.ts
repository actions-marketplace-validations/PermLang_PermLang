// Property-based tests. Each states a rule that must hold for every input; fast-check generates
// hundreds of inputs, hostile ones included, and shrinks any failure to the smallest case. They
// cover the code where a wrong answer is a security problem: escaping untrusted text into GitHub
// workflow commands, deciding whether a declared permission covers a use, and reading the lock
// and workflow files the review gate relies on.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMap, parseDocument, stringify } from "yaml";
import { BUILTIN_CAPABILITIES, BUILTIN_VOCABULARY, covers, formatCapability, parsePermList, type Capability } from "../src/capability.js";
import type { Diagnostic, Report } from "../src/check.js";
import { sqlTables } from "../src/detect/sql-tables.js";
import { parseFlows } from "../src/flows.js";
import { diffLocks, LockError, parseLock, serializeLock, type LockFile } from "../src/lock.js";
import { projectFiles } from "../src/project-files.js";
import { formatAnnotations, toSarif } from "../src/report.js";

/** Anything at all, mixed with the characters that escaping and parsing have to handle. */
const hostile = fc.oneof(
  fc.string({ unit: "binary" }),
  fc.string({ unit: fc.constantFrom("%", "0", "A", "D", "25", "3A", "2C", ":", "::", ",", "\r", "\n", " ", "x", "%0A") }),
);

// --- GitHub annotations and SARIF -----------------------------------------------

describe("output for GitHub", () => {
  const root = path.resolve("/repo");
  const report = (diagnostics: Diagnostic[]): Report =>
    ({ files: 1, functions: [], units: [], diagnostics, unsafe: [], unmapped: [], unresolved: [], tools: [] }) as Report;
  const item = fc
    .record({
      severity: fc.constantFrom("error" as const, "warning" as const),
      code: fc.constantFrom("PERM001" as const, "PERM005" as const, "PERM008" as const, "SPEC003" as const),
      segments: fc.array(fc.stringMatching(/^[a-z0-9%,:_-]{1,8}$/), { minLength: 1, maxLength: 3 }),
      line: fc.integer({ min: 1, max: 100_000 }),
      column: fc.integer({ min: 1, max: 500 }),
      capability: hostile,
      message: hostile,
      fix: fc.option(hostile, { nil: undefined }),
    })
    .map(({ segments, ...d }) => ({
      file: segments.join("/"),
      d: { ...d, file: path.join(root, ...segments), function: "f", call: "" } satisfies Diagnostic,
    }));
  /** How the Actions runner decodes a workflow command's values. */
  const unescape = (s: string) => s.replace(/%(25|0D|0A|3A|2C)/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

  it("writes one workflow command per diagnostic, which decodes back to exactly its text", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 5 }), (items) => {
        const out = formatAnnotations(report(items.map((i) => i.d)), root);
        // A raw line break would let code text start a command of its own.
        expect(out).not.toContain("\r");
        const lines = out === "" ? [] : out.split("\n");
        expect(lines).toHaveLength(items.length);
        const ordered = [...items.filter((i) => i.d.severity === "error"), ...items.filter((i) => i.d.severity === "warning")];
        lines.forEach((line, n) => {
          const { file, d } = ordered[n]!;
          const m = /^::(error|warning) file=([^:,]*),line=(\d+),col=(\d+),title=([^:,]*)::(.*)$/s.exec(line);
          expect(m).not.toBeNull();
          const [, severity, f, l, c, title, message] = m!;
          expect([severity, unescape(f!), Number(l), Number(c)]).toEqual([d.severity, file, d.line, d.column]);
          expect(unescape(title!)).toBe(`PermLang ${d.code}${d.capability ? `: ${d.capability}` : ""}`);
          const lines = d.message.split("\n").map((s) => s.trim());
          expect(unescape(message!)).toBe(lines.join("\n") + (d.fix ? `\n-> ${d.fix}` : ""));
        });
      }),
    );
  });

  it("writes SARIF whose results each name a rule for their code, at a path relative to the repository", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 6 }), (items) => {
        const run = JSON.parse(toSarif(report(items.map((i) => i.d)), root, "0.0.0")).runs[0];
        const rules = run.tool.driver.rules as { id: string; shortDescription: { text: unknown } }[];
        expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
        expect(run.results).toHaveLength(items.length);
        run.results.forEach((r: { ruleId: string; ruleIndex: number; locations: any[] }, n: number) => {
          const { file, d } = items[n]!;
          expect(r.ruleId).toBe(d.code);
          expect(rules[r.ruleIndex]!.id).toBe(r.ruleId);
          expect(typeof rules[r.ruleIndex]!.shortDescription.text).toBe("string");
          const { artifactLocation, region } = r.locations[0].physicalLocation;
          expect([artifactLocation.uri, region.startLine, region.startColumn]).toEqual([file, d.line, d.column]);
        });
      }),
    );
  });
});

// --- Capabilities ---------------------------------------------------------------------

describe("capabilities", () => {
  // An argument as @perm accepts it: no parentheses or wildcards, and no surrounding space.
  const arg = fc.string({ minLength: 1, unit: "binary" }).filter((a) => a.trim() === a && a !== "" && !/[()*]/.test(a));
  const capability: fc.Arbitrary<Capability> = fc
    .record({ name: fc.constantFrom(...BUILTIN_CAPABILITIES), arg: fc.option(arg, { nil: undefined }) })
    .map((c) => (c.name === "exec" ? { name: "exec" } : c));

  it("parses back every list it formats", () => {
    fc.assert(
      fc.property(fc.array(capability, { minLength: 1, maxLength: 5 }), fc.constantFrom(",", ", ", " ,\n  ", ",\t"), (caps, separator) => {
        const { capabilities, errors } = parsePermList(caps.map(formatCapability).join(separator));
        expect(errors).toEqual([]);
        expect(capabilities).toEqual(caps);
      }),
    );
  });

  it("never throws on any @perm text, and reports each error where its text is", () => {
    const text = fc.oneof(hostile, fc.string({ unit: fc.constantFrom("net", "fs.read", "exec", "email.send", "(", ")", ",", " ", "*", "a", ".", "\n") }));
    fc.assert(
      fc.property(text, (t) => {
        const { capabilities, errors } = parsePermList(t);
        for (const c of capabilities) {
          expect(BUILTIN_VOCABULARY.has(c.name)).toBe(true);
          if (c.arg !== undefined) expect(c.arg !== "" && c.arg === c.arg.trim()).toBe(true);
          if (c.name === "exec") expect(c.arg).toBeUndefined();
        }
        for (const e of errors) if (e.text !== "@perm" && e.text !== ",") expect(t.startsWith(e.text, e.offset)).toBe(true);
      }),
    );
  });

  it("a capability covers itself, and a bare one covers every use of its name", () => {
    fc.assert(
      fc.property(capability, (c) => {
        expect(covers([c], c)).toBe(true);
        expect(covers([{ name: c.name }], c)).toBe(true);
      }),
    );
  });

  it("never covers another capability, or a use whose scope is unknown", () => {
    fc.assert(
      fc.property(capability, capability, (declared, used) => {
        if (declared.name !== used.name) expect(covers([declared], used)).toBe(false);
        if (declared.arg !== undefined) expect(covers([declared], { name: used.name, dynamic: true })).toBe(false);
      }),
    );
  });

  it("matches hosts in any case, and only the same host", () => {
    fc.assert(
      fc.property(fc.domain(), fc.domain(), (a, b) => {
        expect(covers([{ name: "net", arg: a }], { name: "net", arg: a.toUpperCase() })).toBe(true);
        expect(covers([{ name: "net", arg: a }], { name: "net", arg: b })).toBe(a.toLowerCase() === b.toLowerCase());
      }),
    );
  });

  it("a path covers exactly the paths inside it", () => {
    // Where each path really is, from a working directory whose folder names differ from the
    // generated ones, so that `../a` can't land back inside it by coincidence.
    const cwd = "/w1/w2/w3/w4/w5/w6/w7/w8/w9/w10";
    const inside = (declared: string, used: string) => {
      const [d, u] = [declared.replaceAll("\\", "/"), used.replaceAll("\\", "/")];
      // A relative path's place under an absolute one depends on where the program runs.
      if (path.posix.isAbsolute(d) !== path.posix.isAbsolute(u)) return false;
      const [D, U] = [path.posix.resolve(cwd, d), path.posix.resolve(cwd, u)];
      return U === D || U.startsWith(D.endsWith("/") ? D : `${D}/`);
    };
    const filePath = fc
      .tuple(fc.boolean(), fc.array(fc.constantFrom("a", "b", ".", "..", "..a"), { minLength: 1, maxLength: 6 }), fc.constantFrom("/", "\\"), fc.boolean())
      .map(([absolute, segments, separator, trailing]) => (absolute ? "/" : "") + segments.join(separator) + (trailing ? separator : ""));
    fc.assert(
      fc.property(fc.constantFrom("fs.read", "fs.write"), filePath, filePath, (name, declared, used) => {
        expect(covers([{ name, arg: declared }], { name, arg: used })).toBe(inside(declared, used));
      }),
      { numRuns: 1000 },
    );
  });
});

// --- SQL ------------------------------------------------------------------------------

describe("SQL table reader", () => {
  // Quoted, so no generated name is a keyword.
  const table = fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/);

  it("never throws on any text: it names the tables, or says it can't", () => {
    const sqlish = fc.string({
      unit: fc.constantFrom("SELECT ", "FROM ", "a", "b.c", '"q"', "`t`", "[x]", "(", ")", ",", ";", "'s'", "--", "/*", "*/", "$1", "?", ":p", "JOIN ", "ON ", "WITH ", "INSERT INTO ", "DELETE FROM ", "UPDATE ", " SET ", "\n"),
    });
    fc.assert(
      fc.property(fc.oneof(hostile, sqlish), (sql) => {
        const tables = sqlTables(sql);
        if (tables) for (const t of [...tables.read, ...tables.write]) expect(typeof t).toBe("string");
      }),
      { numRuns: 500 },
    );
  });

  it("names exactly the tables a simple query reads and writes", () => {
    fc.assert(
      fc.property(table, table, table, (a, b, c) => {
        expect(sqlTables(`SELECT * FROM "${a}" JOIN "${b}" ON 1 = 1`)).toEqual({ read: [...new Set([a, b])], write: [] });
        expect(sqlTables(`INSERT INTO "${c}" (id) SELECT id FROM "${a}"`)).toEqual({ read: [a], write: [c] });
        expect(sqlTables(`DELETE FROM "${c}" WHERE id IN (SELECT id FROM "${b}")`)).toEqual({ read: [b], write: [c] });
      }),
    );
  });
});

// --- The lock file ------------------------------------------------------------------

describe("lock file", () => {
  const key = fc
    .tuple(
      fc.array(fc.stringMatching(/^[a-z0-9._-]{1,6}$/), { minLength: 1, maxLength: 3 }),
      fc.oneof(fc.stringMatching(/^[A-Za-z_$][\w$.]{0,10}$/), fc.constantFrom("<ci.yml>", "<package.json>")),
      fc.option(fc.integer({ min: 2, max: 4 }), { nil: undefined }),
    )
    .map(([dirs, name, n]) => `${dirs.join("/")}#${name}${n ? `#${n}` : ""}`);
  const capabilities = fc.array(fc.oneof(fc.constantFrom("net", "exec", "env(HOME)", "ci.permission(contents: write)"), fc.string()), { maxLength: 4 });
  const lock: fc.Arbitrary<LockFile> = fc
    .record({ functions: fc.dictionary(key, capabilities, { maxKeys: 6 }), unsafe: fc.dictionary(key, fc.string(), { maxKeys: 3 }) })
    .map((l) => ({ permlang: 1, ...l }));

  it("reads back what it writes, and writes it byte for byte the same", () => {
    fc.assert(
      fc.property(lock, (l) => {
        const read = parseLock(serializeLock(l), "permlang.lock.json");
        const sorted = Object.fromEntries(Object.entries(l.functions).map(([k, caps]) => [k, [...caps].sort()]));
        expect(read).toEqual({ permlang: 1, functions: sorted, unsafe: { ...l.unsafe } });
        expect(serializeLock(parseLock(serializeLock(read), "permlang.lock.json"))).toBe(serializeLock(read));
      }),
    );
  });

  it("rejects anything that isn't a lock with a LockError, never a crash", () => {
    const text = fc.oneof(
      hostile,
      fc.jsonValue().map((v) => JSON.stringify(v)),
      fc.record({ permlang: fc.constantFrom(1, 2, "1"), functions: fc.jsonValue(), unsafe: fc.jsonValue() }).map((v) => JSON.stringify(v)),
    );
    fc.assert(
      fc.property(text, (t) => {
        try {
          parseLock(t, "permlang.lock.json");
        } catch (e) {
          expect(e).toBeInstanceOf(LockError);
        }
      }),
    );
  });

  it("diffs: a lock has no changes against itself, and the diff turns one lock into the other", () => {
    fc.assert(
      fc.property(lock, lock, (a, b) => {
        expect(diffLocks(a, a)).toEqual({ functions: [], unsafeAdded: [], unsafeRemoved: [] });
        const diff = diffLocks(a, b);
        for (const k of new Set([...Object.keys(a.functions), ...Object.keys(b.functions)])) {
          const change = diff.functions.find((c) => c.key === k);
          const before = [...new Set(a.functions[k] ?? [])];
          const after = change ? [...before.filter((c) => !change.removed.includes(c)), ...change.added] : before;
          expect(after.sort()).toEqual([...new Set(b.functions[k] ?? [])].sort());
        }
        const back = diffLocks(b, a);
        expect(back.functions.map((c) => [c.key, c.added, c.removed])).toEqual(diff.functions.map((c) => [c.key, c.removed, c.added]));
        expect(back.unsafeAdded.map((u) => u.key).sort()).toEqual(diff.unsafeRemoved.map((u) => u.key).sort());
      }),
    );
  });
});

// --- Workflows and package.json -----------------------------------------------------

describe("project configuration", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "permlang-properties-"));
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const inventory = (file: string, text: string) => {
    writeFileSync(path.join(dir, file), text);
    return projectFiles(dir).find((e) => e.name === `<${path.basename(file)}>`);
  };

  const trigger = fc.constantFrom("push", "pull_request", "pull_request_target", "release", "workflow_dispatch");
  const scope = fc.constantFrom("contents", "issues", "id-token", "pull-requests", "packages");
  const permissions = fc.oneof(fc.constantFrom("read-all", "write-all"), fc.dictionary(scope, fc.constantFrom("read", "write", "none"), { minKeys: 1, maxKeys: 3 }));
  // Full commit SHAs are pinned; tags, branches, and abbreviated SHAs aren't.
  const ref = fc.oneof(fc.stringMatching(/^[0-9a-f]{40}$/), fc.stringMatching(/^[0-9a-f]{7,39}$/), fc.constantFrom("v1", "v4.2.0", "main"));
  const step = fc.oneof(
    fc.tuple(fc.constantFrom("actions/checkout", "acme/deploy", "acme/tools/lint"), ref).map(([name, r]) => ({ uses: `${name}@${r}` })),
    fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,8}$/).map((s) => ({ run: "./deploy.sh", env: { TOKEN: `\${{ secrets.${s} }}` } })),
  );
  const job = fc.record({ "runs-on": fc.constant("ubuntu-latest"), permissions: fc.option(permissions, { nil: undefined }), steps: fc.array(step, { minLength: 1, maxLength: 4 }) });
  const workflow = fc.record({
    on: fc.oneof(
      trigger,
      fc.uniqueArray(trigger, { minLength: 1, maxLength: 3 }),
      fc.uniqueArray(trigger, { minLength: 1, maxLength: 3 }).map((ts) => Object.fromEntries(ts.map((t) => [t, null]))),
    ),
    permissions: fc.option(permissions, { nil: undefined }),
    jobs: fc.dictionary(fc.constantFrom("build", "test", "release", "deploy"), job, { minKeys: 1, maxKeys: 3 }),
  });
  type Workflow = typeof workflow extends fc.Arbitrary<infer W> ? W : never;

  /** What GitHub grants for a workflow, worked out from the object it was written from. */
  function grants(w: Workflow): Set<string> {
    const out = new Set<string>();
    for (const t of typeof w.on === "string" ? [w.on] : Array.isArray(w.on) ? w.on : Object.keys(w.on)) out.add(`ci.trigger(${t})`);
    for (const job of Object.values(w.jobs)) {
      const p = job.permissions ?? w.permissions;
      if (p === undefined) out.add("ci.permission(default)");
      else if (typeof p === "string") out.add(`ci.permission(${p})`);
      else for (const [s, level] of Object.entries(p)) out.add(`ci.permission(${s}: ${level})`);
      for (const s of job.steps) {
        if ("uses" in s) {
          const [name, r] = s.uses.split("@") as [string, string];
          out.add(`ci.action(${name})`);
          if (!/^[0-9a-f]{40}$/.test(r)) out.add(`ci.unpinned(${name})`);
        } else {
          out.add(`ci.secret(${/secrets\.(\w+)/.exec(s.env.TOKEN)![1]})`);
        }
      }
    }
    return out;
  }

  it("records every trigger, token permission, Action, and secret a workflow has, and nothing else", () => {
    fc.assert(
      fc.property(workflow, (w) => {
        expect(new Set(inventory(".github/workflows/ci.yml", stringify(w))?.actual)).toEqual(grants(w));
      }),
      { numRuns: 60 },
    );
  });

  it("never skips a workflow it can't read: it's recorded as unverifiable", () => {
    const text = fc.oneof(hostile, fc.string({ unit: fc.constantFrom("on:", "jobs:", "uses: x@v1", "\n", "  ", "- ", "{", "[", ":", "&a ", "*a", "'", '"') }));
    fc.assert(
      fc.property(text, (t) => {
        const entry = inventory(".github/workflows/ci.yml", t);
        const doc = parseDocument(t, { uniqueKeys: false });
        if (doc.errors.length > 0 || !isMap(doc.contents)) expect(entry?.actual).toEqual(["ci.unverifiable"]);
      }),
      { numRuns: 60 },
    );
  });

  it("records every package.json script with its command", () => {
    const name = fc.oneof(fc.constantFrom("postinstall", "prepare", "test", "build:ts"), fc.string({ minLength: 1 }));
    const scripts = fc.dictionary(name, fc.oneof(fc.string(), fc.jsonValue()), { maxKeys: 5 });
    fc.assert(
      fc.property(scripts, (s) => {
        const entry = inventory("package.json", JSON.stringify({ name: "app", scripts: s }, null, 2));
        const expected = Object.entries(s).filter(([, command]) => typeof command === "string").map(([n, command]) => `npm.script(${n}: ${command})`);
        expect(new Set(entry?.actual ?? [])).toEqual(new Set(expected));
      }),
      { numRuns: 60 },
    );
  });
});

// --- Flow rules ---------------------------------------------------------------------

describe("flow rules", () => {
  it("accepts valid rules, and rejects anything else with a message naming the config file", () => {
    const rule = fc.record({
      from: fc.oneof(fc.constantFrom("env(STRIPE_KEY)", "db.read(users)", "net"), fc.string(), fc.jsonValue()),
      to: fc.oneof(fc.array(fc.oneof(fc.constantFrom("net(api.stripe.com)", "net"), fc.string())), fc.jsonValue()),
    });
    fc.assert(
      fc.property(fc.oneof(fc.array(rule, { maxLength: 3 }), fc.jsonValue()), (raw) => {
        let rules;
        try {
          rules = parseFlows(raw, "permlang.config.json");
        } catch (e) {
          expect((e as Error).message).toMatch(/^permlang\.config\.json: /);
          return;
        }
        expect(rules).toHaveLength((raw as unknown[]).length);
      }),
    );
  });
});
