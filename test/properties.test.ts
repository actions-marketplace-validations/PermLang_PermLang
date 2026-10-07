// Property-based tests. Each states a rule that must hold for every input; fast-check generates
// hundreds of inputs, hostile ones included, and shrinks any failure to the smallest case. They
// cover the code where a wrong answer is a security problem: escaping untrusted text into GitHub
// workflow commands, deciding whether a declared permission covers a use, and reading the lock
// and workflow files the review gate relies on.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Document, isAlias, isMap, parseDocument, stringify, visit, type Node as YamlNode, type Scalar } from "yaml";
import { BUILTIN_CAPABILITIES, BUILTIN_VOCABULARY, covers, formatCapability, parsePermList, type Capability } from "../src/capability.js";
import type { Diagnostic, Report } from "../src/check.js";
import { sqlTables } from "../src/detect/sql-tables.js";
import { parseFlows } from "../src/flows.js";
import { COMMENT_LIMIT, formatDiffMarkdown } from "../src/diff.js";
import { diffLocks, LockError, parseLock, serializeLock, type LockFile } from "../src/lock.js";
import { projectFiles } from "../src/project-files.js";
import { formatAnnotations, printable, toSarif } from "../src/report.js";
import { removeTemporary } from "./temporary.js";

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

  // Code text is shown as the text report shows it: with escapes for line breaks, control
  // characters, and bidirectional overrides, apart from PermLang's own break before a reason.
  const shown = (message: string) => {
    const own = /\n[ \t]*(?=but |which )/.exec(message);
    return own ? `${printable(message.slice(0, own.index))}\n${printable(message.slice(own.index + own[0].length))}` : printable(message);
  };
  const unprintable = new RegExp("[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");

  it("writes one workflow command per diagnostic, which decodes back to exactly its text", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 5 }), (items) => {
        const out = formatAnnotations(report(items.map((i) => i.d)), root);
        // A raw line break would let code text start a command of its own, and an escape
        // sequence or bidirectional override would reach the log as it is.
        expect(out).not.toMatch(unprintable);
        const lines = out === "" ? [] : out.split("\n");
        expect(lines).toHaveLength(items.length);
        const ordered = [...items.filter((i) => i.d.severity === "error"), ...items.filter((i) => i.d.severity === "warning")];
        lines.forEach((line, n) => {
          const { file, d } = ordered[n]!;
          const m = /^::(error|warning) file=([^:,]*),line=(\d+),col=(\d+),title=([^:,]*)::(.*)$/s.exec(line);
          expect(m).not.toBeNull();
          const [, severity, f, l, c, title, message] = m!;
          expect([severity, unescape(f!), Number(l), Number(c)]).toEqual([d.severity, file, d.line, d.column]);
          expect(unescape(title!)).toBe(`PermLang ${d.code}${d.capability ? `: ${printable(d.capability)}` : ""}`);
          expect(unescape(message!)).toBe(shown(d.message) + (d.fix ? `\n-> ${printable(d.fix)}` : ""));
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
          // A URI: only unreserved characters and `/` stay as they are; each segment decodes back.
          expect(artifactLocation.uri).toMatch(/^[\w.~%!*'()/-]*$/);
          const decoded = (artifactLocation.uri as string).split("/").map(decodeURIComponent).join("/");
          expect([decoded, region.startLine, region.startColumn]).toEqual([file, d.line, d.column]);
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
  const relativePath = fc
    .tuple(fc.array(fc.constantFrom("a", "b", ".", "..", "..a"), { minLength: 1, maxLength: 6 }), fc.constantFrom("/", "\\"), fc.boolean())
    .map(([segments, separator, trailing]) => segments.join(separator) + (trailing ? separator : ""));
  const filePath = fc.tuple(fc.boolean(), relativePath).map(([absolute, p]) => (absolute ? "/" : "") + p);

  it("a path covers exactly the paths inside it", () => {
    fc.assert(
      fc.property(fc.constantFrom("fs.read", "fs.write"), filePath, filePath, (name, declared, used) => {
        expect(covers([{ name, arg: declared }], { name, arg: used })).toBe(inside(declared, used));
      }),
      { numRuns: 1000 },
    );
  });

  // A network path read as Windows does: the first two names are the server and the share, as
  // written, and `..` can't climb above the share.
  const inShare = (p: string) => {
    const [server = "", share = "", ...rest] = p.split(/[\\/]/).filter((s) => s !== "");
    const below = path.posix.normalize(`/${rest.join("/")}`).split("/").filter((s) => s !== "" && s !== ".");
    return [server, share, ...below].slice(0, share === "" ? 1 : undefined);
  };
  const insideShare = (declared: string, used: string) => {
    const [d, u] = [inShare(declared), inShare(used)];
    return d.length <= u.length && d.every((s, i) => u[i] === s);
  };

  it("keeps Windows network shares and drive-relative paths under their own root", () => {
    // `\\server\share\x` is absolute, but not under `/`; `C:x` is relative to drive C's own working directory.
    // A network path is covered only when it's inside under both readings: as a plain path (as on
    // other systems, where `//server/share/../x` is `/server/x`) and as Windows reads a share.
    const network = (d: string, u: string) => inside(`/${d}`, `/${u}`) && insideShare(d, u);
    const roots: [string, (d: string, u: string) => boolean][] = [
      ["\\\\", network],
      ["//", network],
      ["C:", inside],
    ];
    fc.assert(
      fc.property(fc.constantFrom("fs.read", "fs.write"), filePath, relativePath, relativePath, (name, other, declared, used) => {
        for (const [root, covered] of roots) {
          expect(covers([{ name, arg: other }], { name, arg: root + used })).toBe(false);
          expect(covers([{ name, arg: root + declared }], { name, arg: root + used })).toBe(covered(declared, used));
        }
      }),
      { numRuns: 500 },
    );
  });

  // Checked against Node's own reading of Windows paths: whatever a share's path does with `..`,
  // a declaration covers it only if Windows puts it inside the declared folder.
  it("never lets `..` climb out of a Windows network share", () => {
    const name = fc.stringMatching(/^[a-z]{1,3}$/);
    const win = (p: string) => path.win32.normalize(p).toLowerCase().replace(/\\$/, "");
    fc.assert(
      fc.property(name, name, name, relativePath, relativePath, (server, share, other, declared, used) => {
        const declaredPath = `\\\\${server}\\${other}\\${declared}`;
        const usedPath = `\\\\${server}\\${share}\\${used}`;
        if (covers([{ name: "fs.write", arg: declaredPath }], { name: "fs.write", arg: usedPath })) {
          const [d, u] = [win(declaredPath), win(usedPath)];
          expect(u === d || u.startsWith(`${d}\\`)).toBe(true);
        }
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

  // A subquery that reads `secrets`, wrapped in shapes that each still run it in at
  // least one of Postgres, MySQL, MariaDB, or SQLite. Whatever the reader answers
  // must include it: a definite answer without it is a silent pass.
  const secret = fc.constantFrom(
    "(SELECT max(id) FROM secrets)",
    '(SELECT id FROM "secrets")',
    "(SELECT id FROM `secrets`)",
    "(SELECT id FROM [secrets])",
    "(SELECT 1 FROM leads JOIN secrets ON 1 = 1)",
    "(SELECT a FROM leads, secrets)",
    "(SELECT x FROM (SELECT x FROM secrets) s)",
  );
  const wrapper = fc.constantFrom<(s: string) => string>(
    (s) => `(${s})`,
    (s) => `lower(${s})`,
    (s) => `coalesce(${s}, 0)`,
    (s) => `CAST(${s} AS int)`,
    (s) => `ROW(${s})`,
    (s) => `"f"(${s})`, // a quoted function name
    (s) => `evil.lower(${s})`, // a schema-qualified one
    (s) => `pg_catalog.count(${s})`,
    (s) => `tags[${s}]`, // a Postgres array subscript
    (s) => `ARRAY[1, ${s}]`,
    (s) => `1--1 OR ${s}`, // MySQL: 1 minus -1, then the subquery
    (s) => `1 # ${s}`, // Postgres: an operator; MySQL: a comment
    (s) => `/*! ${s} */`, // MySQL runs it
    (s) => `/*M! ${s} */`, // MariaDB runs it
    (s) => `('a\\', ${s}, 'b')`, // Postgres: three values; MySQL: one string
    (s) => `CASE WHEN ${s} > 0 THEN 1 ELSE 0 END`,
    (s) => `EXISTS ${s}`,
    (s) => `x IN (1, ${s})`,
    (s) => `${s} IS DISTINCT FROM 1`,
    (s) => `1 IS DISTINCT FROM ${s}`,
    (s) => `EXTRACT(YEAR FROM ${s})`,
    (s) => `SUBSTRING(x FROM ${s})`,
    (s) => `'a' || ${s}`,
    (s) => `/* note */ ${s} -- note\n`,
    (s) => `1 -- note\r${s}`, // Postgres ends the comment at \r
    (s) => `E'\\'' || ${s}`,
    (s) => `$$x$$ || ${s}`,
    (s) => `count(*) OVER (ORDER BY ${s})`,
    (s) => `count(*) FILTER (WHERE ${s} > 0)`,
    (s) => `x = ANY(${s})`,
    (s) => `NOT ${s}`,
    (s) => `${s} BETWEEN 1 AND 2`,
    (s) => `${s}::int`,
    (s) => `IF(${s}, 1, 2)`,
    (s) => `CASE ${s} WHEN 1 THEN 2 END`,
    (s) => `(SELECT ${s})`,
    (s) => `(SELECT 1 WHERE ${s} > 0)`,
    (s) => `[f](${s})`,
    (s) => `"s"."f"(${s})`,
    (s) => `x[1][${s}]`,
  );
  const expressionIn = fc.constantFrom<(e: string) => string>(
    (e) => `SELECT ${e} FROM leads`,
    (e) => `SELECT * FROM leads WHERE id = ${e}`,
    (e) => `SELECT * FROM leads l JOIN teams t ON t.id = ${e}`,
    (e) => `SELECT * FROM leads GROUP BY a HAVING ${e} > 1 ORDER BY ${e}`,
    (e) => `SELECT * FROM leads LIMIT ${e}`,
    (e) => `UPDATE leads SET x = ${e} WHERE id = 1`,
    (e) => `DELETE FROM leads WHERE x = ${e}`,
    (e) => `INSERT INTO leads (a) VALUES (${e})`,
    (e) => `INSERT INTO leads (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = ${e}`,
  );
  const sourceOf = fc.constantFrom<(s: string) => string>(
    (s) => `INSERT INTO leads ${s}`,
    (s) => `INSERT INTO leads (a) ${s}`,
    (s) => `INSERT INTO leads ${s.slice(1, -1)}`,
  );
  const hiding = fc.oneof(
    fc.tuple(expressionIn, fc.array(wrapper, { maxLength: 3 }), secret).map(([at, wraps, s]) => at(wraps.reduce<string>((e, w) => w(e), s))),
    fc.tuple(sourceOf, secret).map(([at, s]) => at(s)),
  );

  it("never names fewer tables than a query reads, however the subquery is hidden", () => {
    fc.assert(
      fc.property(hiding, (sql) => {
        const tables = sqlTables(sql);
        if (tables) expect(tables.read, sql).toContain("secrets");
      }),
      { numRuns: 3000 },
    );
  });

  // Placeholders and names glued to the text around them, which the dialects split into
  // tokens differently: MySQL and SQLite read `?FROM` as `?` and FROM, and SQLite reads
  // `:a('x)` as one variable and `[']` as one name. Each shape reads secrets in at least one.
  const glued = fc.oneof(
    fc
      .tuple(
        fc.constantFrom("?", "?1", "?12", "$1", ":1"),
        fc.constantFrom<(p: string) => string>(
          (p) => `SELECT name, ${p}FROM secrets`,
          (p) => `INSERT INTO leads (name) SELECT ${p}FROM secrets`,
          (p) => `SELECT * FROM leads WHERE id IN (SELECT ${p}FROM secrets)`,
        ),
      )
      .map(([p, at]) => at(p)),
    fc
      .tuple(fc.constantFrom(":a", "@a", "$1", ":1", ":a::b", ":a::", "$1::1lower", "$1::numeric"), fc.constantFrom("'", '"', "`", "["))
      .map(([v, q]) => `SELECT ${v}(${q}x) FROM secrets --${q === "[" ? "]" : q})`),
    fc.constantFrom("'", '"', "`", "--", "/*", "/* */ '").map((q) => `SELECT [${q}] FROM secrets -- ${q}] FROM leads`),
  );

  it("never names fewer tables than a query reads, whatever a placeholder or name is glued to", () => {
    fc.assert(
      fc.property(glued, (sql) => {
        const tables = sqlTables(sql);
        if (tables) expect(tables.read, sql).toContain("secrets");
      }),
      { numRuns: 500 },
    );
  });

  // mysql2's query() pastes each value, escaped, at a `?` (older versions at every one, in
  // strings and comments too). A value can't add a table the reader didn't name.
  it("never names fewer tables than a query reads once the client pastes values in", () => {
    const holder = fc.constantFrom("?", "'?'", "`?`", '"?"', "'a ? b'", "/* ? */ 1", "1 -- ?\n", "'?', ?", "lower('?')");
    const statement = fc.constantFrom<(h: string) => string>(
      (h) => `SELECT ${h} FROM leads`,
      (h) => `SELECT * FROM leads WHERE id = 1 AND ${h} = 1`,
      (h) => `UPDATE leads SET a = ${h} WHERE id = 1`,
      (h) => `INSERT INTO leads (a) VALUES (${h})`,
    );
    const text = fc.oneof(
      fc.tuple(statement, holder).map(([at, h]) => at(h)),
      fc.string({
        unit: fc.constantFrom("SELECT ", "a ", "FROM leads ", "WHERE x = ", "?", "'", "`", '"', "/* ", " */", "-- ", "\n", ", ", "(", ")"),
        maxLength: 14,
      }),
    );
    // Each escapes to itself in quotes: sqlstring changes only quotes, backslashes, and control characters.
    const hostile = fc.constantFrom("x FROM secrets -- ", "x` FROM secrets -- ", "*/ , (SELECT 1 FROM secrets) /*", ") , (SELECT 1 FROM secrets) -- ");
    fc.assert(
      fc.property(text, hostile, (sql, value) => {
        const tables = sqlTables(sql, { formatted: true });
        if (!tables) return;
        const sent = sqlTables(sql.replace(/\?+/g, (m) => (m.length === 1 ? `'${value}'` : m)));
        if (sent) for (const t of sent.read) expect(tables.read, sql).toContain(t);
      }),
      { numRuns: 3000 },
    );
  });

  it("gives up on nesting of any depth instead of overflowing the stack", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20_000 }), fc.constantFrom("(", "(SELECT 1 FROM t WHERE x IN ", "lower(", "tags[("), (depth, open) => {
        const close = open.endsWith("[(") ? ")]" : ")";
        expect(() => sqlTables(`SELECT ${open.repeat(depth)}1${close.repeat(depth)} FROM leads`)).not.toThrow();
      }),
      { numRuns: 50 },
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
  // Keys named like Object's own properties crashed the diff (found in the code review, O2).
  const anyKey = fc.oneof({ weight: 4, arbitrary: key }, fc.constantFrom("toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"));
  const capabilities = fc.array(fc.oneof(fc.constantFrom("net", "exec", "env(HOME)", "ci.permission(contents: write)"), fc.string()), { maxLength: 4 });
  const lock: fc.Arbitrary<LockFile> = fc
    .record({ functions: fc.dictionary(anyKey, capabilities, { maxKeys: 6, noNullPrototype: true }), unsafe: fc.dictionary(anyKey, fc.string(), { maxKeys: 3, noNullPrototype: true }) })
    .map((l) => ({ permlang: 2, ...l }));
  const ownEntries = <T>(r: Record<string, T>) => Object.keys(r).map((k) => [k, Object.getOwnPropertyDescriptor(r, k)!.value as T] as const);

  it("reads back what it writes, and writes it byte for byte the same", () => {
    fc.assert(
      fc.property(lock, (l) => {
        const read = parseLock(serializeLock(l), "permlang.lock.json");
        expect(read.permlang).toBe(2);
        expect(ownEntries(read.functions)).toEqual(ownEntries(l.functions).map(([k, caps]) => [k, [...caps].sort()]).sort(([a], [b]) => (a < b ? -1 : 1)));
        expect(ownEntries(read.unsafe).sort()).toEqual([...ownEntries(l.unsafe)].sort());
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
        expect(diffLocks(a, a)).toEqual({ functions: [], unsafeAdded: [], unsafeRemoved: [], unsafeChanged: [] });
        const diff = diffLocks(a, b);
        const own = (r: Record<string, string[]>, k: string) => (Object.hasOwn(r, k) ? r[k]! : []);
        for (const k of new Set([...Object.keys(a.functions), ...Object.keys(b.functions)])) {
          const change = diff.functions.find((c) => c.key === k);
          const before = [...new Set(own(a.functions, k))];
          const after = change ? [...before.filter((c) => !change.removed.includes(c)), ...change.added] : before;
          expect(after.sort()).toEqual([...new Set(own(b.functions, k))].sort());
        }
        const back = diffLocks(b, a);
        expect(back.functions.map((c) => [c.key, c.added, c.removed])).toEqual(diff.functions.map((c) => [c.key, c.removed, c.added]));
        expect(back.unsafeAdded.map((u) => u.key).sort()).toEqual(diff.unsafeRemoved.map((u) => u.key).sort());
        expect(back.unsafeChanged.map((u) => [u.key, u.before, u.after])).toEqual(diff.unsafeChanged.map((u) => [u.key, u.after, u.before]));
      }),
    );
  });
});

// --- The pull-request comment -----------------------------------------------------------

describe("the permission diff comment", () => {
  const name = fc.oneof(fc.stringMatching(/^[A-Za-z_$][\w$]{0,30}$/), hostile);
  const change = fc.record({
    file: fc.stringMatching(/^[a-z0-9/._-]{1,20}$/),
    name,
    added: fc.uniqueArray(fc.oneof(fc.constantFrom("net", "exec", "env(HOME)", "net(api.example.com)"), hostile), { minLength: 1, maxLength: 4 }),
  });
  const diff = fc
    .record({
      changes: fc.array(change, { maxLength: 40 }),
      reasons: fc.array(hostile, { maxLength: 3 }),
    })
    .map(({ changes, reasons }) => ({
      functions: changes.map((c, i) => ({ key: `${c.file}#${c.name}#${i + 2}`, file: c.file, name: c.name, status: "changed" as const, added: c.added, removed: [] })),
      unsafeAdded: reasons.map((reason, i) => ({ key: `src/u.ts#f#${i + 2}`, reason })),
      unsafeRemoved: [],
      unsafeChanged: [],
    }));
  const limit = fc.integer({ min: 2_000, max: 20_000 });

  it("never exceeds the size limit, and always keeps its marker, heading, and footer", () => {
    fc.assert(
      fc.property(diff, limit, (d, max) => {
        const md = formatDiffMarkdown(d, {}, { marker: "<!-- permlang-diff -->" }, max);
        expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(max);
        expect(md.startsWith("<!-- permlang-diff -->\n### PermLang permission diff")).toBe(true);
        if (d.functions.length > 0) expect(md).toContain("Approving this change approves the access above");
      }),
    );
  });

  it("keeps the table of new access before anything else, cut short with a note", () => {
    const many = { functions: Array.from({ length: 3_000 }, (_, i) => ({ key: `src/f${i}.ts#f`, file: `src/f${i}.ts`, name: "f", status: "changed" as const, added: [`net(host${i}.example)`], removed: [] })), unsafeAdded: [], unsafeRemoved: [], unsafeChanged: [] };
    const md = formatDiffMarkdown(many, {}, {});
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(COMMENT_LIMIT);
    expect(md).toContain("| New access | Where it happens | Now reachable from |");
    expect(md).toMatch(/\*\*Cut short\*\* to fit GitHub's limit on comment length: \d+ more lines aren't shown/);
  });

  it("can't be made to mention people, link issues, or show emoji by text from the code", () => {
    const sneaky = fc.constantFrom("@octocat", "@org/team", "#12", "owner/repo#3", "GH-4", "https://evil.example", "www.evil.example", ":tada:", "a5c3785ed8d6a35868bc169f07e40e889087fd2e", "~~gone~~", "$x$");
    fc.assert(
      fc.property(fc.array(fc.oneof(sneaky, hostile), { minLength: 1, maxLength: 4 }), (parts) => {
        const text = parts.join(" ");
        const md = formatDiffMarkdown({ functions: [{ key: "src/a.ts#f", file: "src/a.ts", name: "f", status: "changed", added: ["net"], removed: [] }], unsafeAdded: [{ key: "src/a.ts#f", reason: text }], unsafeRemoved: [], unsafeChanged: [] }, { "src/a.ts#f": { net: ["f", text] } });
        // Outside code formatting, where GitHub links and notifies.
        const outside = md.replace(/<code>.*?<\/code>/g, "");
        // Markdown syntax (strikethrough, math) is read from the source: it must be escaped there.
        expect(outside.replace(/&#?\w+;/g, "")).not.toMatch(/~~|\$/);
        // Mentions, references, and links are found in the rendered text, after entities are decoded.
        const decoded = outside.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&\w+;/g, " ");
        expect(decoded).not.toMatch(/@\w|#\d|\bgh-\d|:\/\/|\bwww\.|:\w+:|\b[0-9a-f]{7,}\b/i);
      }),
    );
  });
});

describe("printable text", () => {
  it("never contains a line break or a control character, and leaves other text alone", () => {
    fc.assert(
      fc.property(fc.oneof(hostile, fc.string({ unit: "grapheme" })), (t) => {
        const p = printable(t);
        expect(p).not.toMatch(/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u);
        if (!/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u.test(t)) expect(p).toBe(t);
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
  afterAll(() => removeTemporary(dir));
  const inventory = (file: string, text: string) => {
    writeFileSync(path.join(dir, file), text);
    return projectFiles(dir).find((e) => e.name === `<${path.basename(file)}>`);
  };

  // Each generated piece of a workflow comes with what it grants, so the expected
  // inventory is worked out from how the workflow was built, not by reading it back.
  type Granting<T> = { yaml: T; grants: string[] };

  const trigger = fc.constantFrom("push", "pull_request", "pull_request_target", "release", "workflow_dispatch");
  const scope = fc.constantFrom("contents", "issues", "id-token", "pull-requests", "packages");
  // `{}` grants nothing; `permissions: null` (no value) is read as no block at all.
  const permissions = fc.oneof(fc.constantFrom("read-all", "write-all", null), fc.dictionary(scope, fc.constantFrom("read", "write", "none"), { maxKeys: 3 }));
  // Full commit SHAs are pinned; tags, branches, and abbreviated SHAs aren't.
  const ref = fc.oneof(fc.stringMatching(/^[0-9a-f]{40}$/), fc.stringMatching(/^[0-9a-f]{7,39}$/), fc.constantFrom("v1", "v4.2.0", "main"));
  const action: fc.Arbitrary<Granting<{ uses: string }>> = fc
    .tuple(fc.constantFrom("actions/checkout", "acme/deploy", "acme/tools/lint"), ref)
    .map(([name, r]) => ({ yaml: { uses: `${name}@${r}` }, grants: [`ci.action(${name})`, ...(/^[0-9a-f]{40}$/.test(r) ? [] : [`ci.unpinned(${name})`])] }));
  // An image's name is everything but its tag and digest, its registry's port included; only a digest pins it.
  const image = fc
    .record({
      registry: fc.option(fc.constantFrom("ghcr.io", "ghcr.io:443", "localhost:5000", "registry.example.com:8080"), { nil: undefined }),
      path: fc.array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 3 }),
      tag: fc.option(fc.constantFrom("latest", "1.0", "3.20-alpine"), { nil: undefined }),
      digest: fc.option(fc.stringMatching(/^[0-9a-f]{64}$/), { nil: undefined }),
    })
    .map(({ registry, path: segments, tag, digest }) => {
      const name = [registry, ...segments].filter(Boolean).join("/");
      const ref = `${name}${tag ? `:${tag}` : ""}${digest ? `@sha256:${digest}` : ""}`;
      return { ref, grants: [`ci.action(docker://${name})`, ...(digest ? [] : [`ci.unpinned(docker://${name})`])] };
    });
  // A secret, however an expression spells it: any case, any spacing, a property or an index.
  const named = fc
    .tuple(fc.constantFrom("secrets", "SECRETS", "Secrets"), fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/), fc.constantFrom("", " ", "  "), fc.boolean(), fc.constantFrom("'", '"'))
    .map(([context, name, space, dotted, quote]) => ({
      expression: dotted ? `${context}${space}.${space}${name}` : `${context}${space}[${space}${quote}${name}${quote}${space}]`,
      grants: [`ci.secret(${name.toUpperCase()})`],
      mention: `${context}.${name}`,
    }));
  // ...and every secret at once, when the names aren't written out.
  const whole = fc
    .constantFrom("toJSON(secrets)", "secrets[matrix.name]", "join(secrets.*, ',')", "secrets", "fromJSON(toJSON(SECRETS)).x", "secrets[format('{0}_KEY', 'AWS')]")
    .map((expression) => ({ expression, grants: ["ci.secret(all)"], mention: expression }));
  const secretStep: fc.Arbitrary<Granting<object>> = fc
    .tuple(fc.oneof(named, whole), fc.constantFrom("env", "if", "text", "string"))
    .map(([s, where]) =>
      where === "env"
        ? { yaml: { run: "./deploy.sh", env: { TOKEN: `\${{ ${s.expression} }}` } }, grants: s.grants }
        : where === "if"
          ? { yaml: { if: `${s.expression} != ''`, run: "./deploy.sh" }, grants: s.grants }
          : // Mentioned outside an expression, or inside a string in one: not read.
            { yaml: { name: `uses ${s.mention}`, run: where === "text" ? `echo ${s.mention}` : `echo \${{ '${s.mention.replaceAll("'", "''")}' }}` }, grants: [] },
    );
  const dockerStep = image.map((i) => ({ yaml: { uses: `docker://${i.ref}` }, grants: i.grants }));
  const step = fc.oneof(action, secretStep, dockerStep);
  const job = fc.record({
    "runs-on": fc.constant("ubuntu-latest"),
    permissions: fc.option(permissions, { nil: undefined }),
    container: fc.option(image, { nil: undefined }),
    steps: fc.array(step, { minLength: 1, maxLength: 4 }),
  });
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

  /** The workflow as it's written. */
  const asYaml = (w: Workflow) => ({
    ...w,
    jobs: Object.fromEntries(
      Object.entries(w.jobs).map(([id, { container, steps, ...job }]) => [id, { ...job, ...(container ? { container: container.ref } : {}), steps: steps.map((s) => s.yaml) }]),
    ),
  });

  /** What GitHub grants for a workflow, worked out from how it was built. */
  function grants(w: Workflow): Set<string> {
    const out = new Set<string>();
    for (const t of typeof w.on === "string" ? [w.on] : Array.isArray(w.on) ? w.on : Object.keys(w.on)) out.add(`ci.trigger(${t})`);
    for (const job of Object.values(w.jobs)) {
      const p = job.permissions !== undefined ? job.permissions : w.permissions;
      if (p === undefined || p === null) out.add("ci.permission(default)");
      else if (typeof p === "string") out.add(`ci.permission(${p})`);
      else for (const [s, level] of Object.entries(p)) out.add(`ci.permission(${s}: ${level})`);
      for (const g of [...(job.container?.grants ?? []), ...job.steps.flatMap((s) => s.grants)]) out.add(g);
    }
    return out;
  }

  /** The same YAML with repeated values, keys, and blocks written as aliases of their first occurrence. */
  function withAliases(value: unknown, choices: boolean[]): string {
    const doc = new Document(value);
    const first = new Map<string, YamlNode>();
    let n = 0;
    visit(doc, {
      Node(_, node) {
        if (isAlias(node)) return;
        const shape = JSON.stringify(node.toJSON());
        const earlier = first.get(shape);
        if (!earlier) first.set(shape, node);
        else if (choices[n++ % choices.length]) return doc.createAlias(earlier as Scalar);
      },
    });
    return doc.toString();
  }

  it("records every trigger, token permission, Action, image, and secret a workflow has, and nothing else", () => {
    fc.assert(
      fc.property(workflow, (w) => {
        expect(new Set(inventory(".github/workflows/ci.yml", stringify(asYaml(w)))?.actual)).toEqual(grants(w));
      }),
      { numRuns: 100 },
    );
  });

  it("reads a workflow the same when it's written with anchors and aliases", () => {
    fc.assert(
      fc.property(workflow, fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), (w, choices) => {
        const aliased = withAliases(asYaml(w), choices);
        expect(new Set(inventory(".github/workflows/ci.yml", aliased)?.actual), aliased).toEqual(grants(w));
      }),
      { numRuns: 100 },
    );
  });

  it("never skips a workflow it can't read: it's recorded as unverifiable, with the file's hash", () => {
    const text = fc.oneof(hostile, fc.string({ unit: fc.constantFrom("on:", "jobs:", "uses: x@v1", "\n", "  ", "- ", "{", "[", ":", "&a ", "*a", "*b", "'", '"', "\uFEFF") }));
    fc.assert(
      fc.property(text, (t) => {
        const entry = inventory(".github/workflows/ci.yml", t);
        // As written to disk, where a lone surrogate becomes U+FFFD.
        const written = readFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "utf8").replace(/^\uFEFF/, "");
        const unverifiable = `ci.unverifiable(sha256:${createHash("sha256").update(written.replaceAll("\r\n", "\n")).digest("hex")})`;
        const doc = parseDocument(written, { uniqueKeys: false, schema: "core" });
        if (doc.errors.length > 0 || !isMap(doc.contents)) expect(entry?.actual).toEqual([unverifiable]);
        // An alias with no anchor before it can't be followed: whatever it stands for is unknown.
        let unresolved = false;
        visit(doc, { Alias: (_, alias) => void (unresolved ||= alias.resolve(doc) === undefined) });
        if (unresolved) expect(entry?.actual).toContain(unverifiable);
      }),
      { numRuns: 100 },
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
