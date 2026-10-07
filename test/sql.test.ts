// Reading table names out of literal SQL, for raw-SQL database clients.
//
// The reader fails closed: it gives a definite answer only for statement shapes it
// fully understands, and `undefined` (unknown) for everything else. Unknown SQL
// needs bare db.read and db.write. A wrong "safe" answer is a silent pass.

import { describe, expect, it } from "vitest";
import { isStatement } from "../src/detect/drizzle.js";
import { sqlTables } from "../src/detect/sql-tables.js";

describe("sqlTables: understood statements", () => {
  it.each([
    ["SELECT * FROM leads WHERE id = $1", { read: ["leads"], write: [] }],
    ["select l.name from leads l join teams t on t.id = l.team_id", { read: ["leads", "teams"], write: [] }],
    ["SELECT * FROM a, b AS bee, c", { read: ["a", "b", "c"], write: [] }],
    ["SELECT * FROM a LEFT OUTER JOIN b USING (id) CROSS JOIN c", { read: ["a", "b", "c"], write: [] }],
    ["SELECT * FROM a STRAIGHT_JOIN b ON a.id = b.id", { read: ["a", "b"], write: [] }],
    ["SELECT * FROM (SELECT id FROM leads) sub", { read: ["leads"], write: [] }],
    ["SELECT * FROM a WHERE id IN (SELECT a_id FROM b) AND EXISTS (SELECT 1 FROM c)", { read: ["a", "b", "c"], write: [] }],
    ["SELECT count(*), max(x), coalesce(y, 0), lower(z) FROM a GROUP BY 1 ORDER BY 2 DESC LIMIT 5", { read: ["a"], write: [] }],
    ["SELECT (SELECT max(x) FROM secrets) FROM a", { read: ["secrets", "a"], write: [] }],
    ["SELECT * FROM a WHERE x = (SELECT y FROM b) AND (z > 1 OR w < 2)", { read: ["a", "b"], write: [] }],
    ["SELECT CASE WHEN (x > 1) THEN 1 ELSE 0 END FROM a ORDER BY (x + 1)", { read: ["a"], write: [] }],
    ["SELECT * FROM a JOIN b ON a.x = (SELECT y FROM c)", { read: ["a", "b", "c"], write: [] }],
    ["SELECT EXTRACT(YEAR FROM created) FROM a WHERE b IS DISTINCT FROM c", { read: ["a"], write: [] }],
    ['SELECT * FROM "public"."users"', { read: ["public.users"], write: [] }],
    ["SELECT * FROM `orders` LEFT JOIN `items` ON 1=1", { read: ["orders", "items"], write: [] }],
    [`SELECT a AS "o'clock" FROM secrets`, { read: ["secrets"], write: [] }],
    ['SELECT * FROM "x--y" JOIN secrets ON 1 = 1', { read: ["x--y", "secrets"], write: [] }],
    ["SELECT 'FROM fake' AS x FROM real_table", { read: ["real_table"], write: [] }],
    ["-- FROM secrets\nSELECT 1 /* FROM hidden */", { read: [], write: [] }],
    ["SELECT * FROM jobs WHERE id = $1 FOR UPDATE SKIP LOCKED", { read: ["jobs"], write: [] }],
    ["INSERT INTO audit (event) VALUES ($1)", { read: [], write: ["audit"] }],
    ["INSERT INTO audit (event) SELECT name FROM events", { read: ["events"], write: ["audit"] }],
    ["INSERT IGNORE INTO secrets VALUES (1)", { read: [], write: ["secrets"] }],
    ["INSERT LOW_PRIORITY INTO secrets VALUES (1)", { read: [], write: ["secrets"] }],
    ["INSERT secrets VALUES (1)", { read: [], write: ["secrets"] }],
    ["INSERT OR REPLACE INTO cache (k, v) VALUES (?, ?)", { read: [], write: ["cache"] }],
    ["INSERT INTO a (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET v = excluded.v", { read: [], write: ["a"] }],
    ["INSERT INTO a (id) VALUES (1) ON DUPLICATE KEY UPDATE v = 2", { read: [], write: ["a"] }],
    ["INSERT INTO a (id) VALUES (1) RETURNING id", { read: [], write: ["a"] }],
    ["UPDATE leads SET name = $1 FROM teams WHERE teams.id = leads.team_id", { read: ["teams"], write: ["leads"] }],
    ["UPDATE IGNORE secrets SET v = 1", { read: [], write: ["secrets"] }],
    ["DELETE FROM sessions WHERE expires < now()", { read: [], write: ["sessions"] }],
    ["DELETE IGNORE FROM secrets WHERE id = 1", { read: [], write: ["secrets"] }],
    ["SELECT * FROM [users] JOIN [dbo].[orders] ON 1 = 1", { read: ["users", "dbo.orders"], write: [] }],
    ["SELECT * FROM a WHERE id = :id AND b = @b AND c = ?;", { read: ["a"], write: [] }],
    ["SELECT * FROM ONLY parent WHERE b IS NOT DISTINCT FROM c", { read: ["parent"], write: [] }],
    ["SELECT * FROM (SELECT id FROM b) AS s (x)", { read: ["b"], write: [] }],
    ["INSERT INTO a AS t (id) VALUES (1)", { read: [], write: ["a"] }],
    ["DELETE FROM ONLY a WHERE x = 1", { read: [], write: ["a"] }],
    ["-- nothing but a comment", { read: [], write: [] }],
    // Found in the third review: shapes whose tables were read only in part.
    ["SELECT * FROM leads WHERE tags[(SELECT max(id) FROM secrets)] = 1", { read: ["leads", "secrets"], write: [] }],
    ["SELECT tags[1], tags[1:2], ARRAY[1, 2] FROM leads", { read: ["leads"], write: [] }],
    ["INSERT INTO leads (id) (SELECT id FROM secrets)", { read: ["secrets"], write: ["leads"] }],
    ["SELECT a --\nFROM leads", { read: ["leads"], write: [] }],
    ["SELECT a --\tcomment\nFROM leads --", { read: ["leads"], write: [] }],
    ["SELECT a -- Windows line ends\r\nFROM leads", { read: ["leads"], write: [] }],
    ["SELECT * FROM leads WHERE x = ANY('{1,2}'::int[])", { read: ["leads"], write: [] }],
    ['SELECT * FROM [order details] JOIN b USING (id, "k")', { read: ["order details", "b"], write: [] }],
    // Found in the fourth review: MySQL and SQLite read `?` on its own, so a keyword after it is a keyword.
    ["INSERT INTO leads (name) SELECT ?FROM secrets", { read: ["secrets"], write: ["leads"] }],
    ["SELECT name, ?FROM secrets", { read: ["secrets"], write: [] }],
    ["SELECT name, ?1FROM secrets", { read: ["secrets"], write: [] }],
    ["SELECT * FROM leads WHERE id = ?1 OR id = ?12", { read: ["leads"], write: [] }],
    // Placeholders and subscripts the review's fixes must keep reading.
    ["SELECT * FROM leads WHERE id = $1::int AND tags && $2::text[]", { read: ["leads"], write: [] }],
    ["SELECT $1::numeric(10,2), amount::varchar(255) FROM leads", { read: ["leads"], write: [] }],
    ["SELECT data['name'], data['a']['b'] FROM leads", { read: ["leads"], write: [] }],
    ["SELECT * FROM leads WHERE id = :id AND tag = @tag", { read: ["leads"], write: [] }],
    // Built-in clocks and generators, which drizzle column defaults put into inserts.
    ["SELECT gen_random_uuid(), random(), clock_timestamp(), current_timestamp(3)", { read: [], write: [] }],
    ["SELECT uuid(), rand(), utc_timestamp(), unixepoch(), datetime('now'), strftime('%s', 'now'), julianday('now')", { read: [], write: [] }],
  ])("%s", (sql, expected) => {
    expect(sqlTables(sql)).toEqual(expected);
  });
});

describe("sqlTables: anything else is unknown", () => {
  it.each([
    // Statement kinds outside the grammar.
    "CALL refresh_all()",
    "DO $$ BEGIN PERFORM 1; END $$",
    "EXECUTE my_plan",
    "TABLE secrets",
    "CREATE TABLE IF NOT EXISTS logs (id int)",
    "CREATE INDEX ON secrets (id)",
    "CREATE FUNCTION f() RETURNS void AS 'DELETE FROM users' LANGUAGE sql",
    "DROP TABLE a, secrets",
    "DROP SCHEMA public CASCADE",
    "DROP DATABASE app",
    "TRUNCATE a, secrets",
    "MERGE INTO a USING secrets ON a.id = secrets.id WHEN MATCHED THEN DELETE",
    "COPY secrets TO '/tmp/x'",
    // Several statements.
    "SELECT * FROM leads; DROP TABLE users",
    // Shapes that hide tables or writes.
    "SELECT * FROM a UNION TABLE secrets",
    "SELECT * FROM a UNION SELECT * FROM secrets",
    "SELECT * FROM a WHERE x IN (SELECT y FROM b UNION SELECT z FROM secrets)",
    "WITH users AS (SELECT * FROM users) SELECT * FROM users",
    "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
    "SELECT * INTO newtab FROM a",
    "SELECT * FROM a INTO OUTFILE '/tmp/x'",
    "SELECT row_number() OVER w FROM a WINDOW w AS (ORDER BY id)",
    "SELECT * FROM a, LATERAL (SELECT * FROM secrets) s",
    "DELETE FROM a USING secrets WHERE a.id = secrets.id",
    "DELETE secrets FROM secrets JOIN a ON 1 = 1",
    "UPDATE a, secrets SET a.v = 1",
    // Functions that read files, write, or run SQL; table functions.
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT setval('seq', 1)",
    "SELECT dblink_exec('DELETE FROM users')",
    "SELECT my_function()",
    "SELECT * FROM generate_series(1, 10)",
    // Lexical forms whose meaning depends on the dialect.
    "SELECT 'x\\'', y FROM secrets",
    "SELECT E'x\\'' FROM secrets",
    "SELECT * FROM a # it's\nJOIN secrets",
    "SELECT * FROM a /*!, secrets */",
    "SELECT * FROM ümlaut",
    "SELECT * FROM a WHERE x = 'unterminated",
    "SELECT * FROM [secrets",
    "SELECT * FROM a /* outer /* inner */ secrets */",
    "SELECT * FROM a /* never closed",
    // Shapes the grammar doesn't cover.
    "SELECT * FROM a AS",
    "SELECT * FROM (VALUES (1)) v",
    "SELECT * FROM a LEFT secrets",
    "SELECT * FROM a JOIN secrets USING id",
    "SELECT * FROM a) JOIN (secrets",
    "SELECT * FROM (a",
    // A placeholder where a table name goes (postgres.js `${sql(t)}`).
    "SELECT * FROM $1",
    "DELETE FROM ?",
    // Found in the third review: each of these was read as touching fewer tables than it does.
    "INSERT INTO leads (SELECT * FROM secrets)",
    "INSERT INTO leads ((id))",
    "SELECT \"dblink_exec\"('h', 'DELETE FROM users')",
    "SELECT \"lower\"(name) FROM leads",
    "SELECT evil.lower(id) FROM leads",
    "SELECT pg_catalog.count(*) FROM leads",
    // MySQL needs a space after --, so this runs the subquery there.
    "SELECT * FROM leads WHERE 1--1 OR (SELECT max(id) FROM secrets) > 0",
    "SELECT 1 --x\nFROM secrets",
    "SELECT 1 -- x\nFROM secrets",
    // MySQL reads double quotes as a string with backslash escapes: this reads leads there.
    "SELECT \"a\\\" FROM secrets -- \" FROM leads",
    // MariaDB runs /*M! ... */ as SQL.
    "SELECT * FROM a /*M! , secrets */",
    // Names that read differently from how they're written, or can't be declared.
    "SELECT * FROM U&\"\\0073ecrets\"",
    "SELECT * FROM \"audit.log\"",
    "SELECT * FROM \"\"",
    "SELECT * FROM \"leads \"",
    "SELECT * FROM \"x), net(evil\"",
    "SELECT * FROM [x, secrets]",
    // Column lists that aren't lists of names.
    "SELECT * FROM a x((SELECT 1 FROM secrets))",
    "SELECT * FROM a JOIN b USING ((SELECT 1 FROM secrets))",
    "SELECT * FROM a JOIN b USING (select)",
    // Postgres ends a comment at a lone \r.
    "SELECT a -- note\rFROM secrets",
    // Postgres's U&"..." is the table secrets, not U.
    'DELETE FROM U&"secrets"',
    'INSERT INTO U&"secrets" VALUES (1)',
    // Found in the fourth review. SQLite reads a variable's name up to a Tcl-style suffix,
    // `:a(...)`, which runs to the first `)`: the quote inside it starts no string there.
    "SELECT :a('x) FROM secrets --')",
    "SELECT @a('x) FROM secrets --')",
    "SELECT $1('x) FROM secrets --')",
    "SELECT :1('x) FROM secrets --')",
    "SELECT :a::b('x) FROM secrets --')",
    "SELECT :a::('x) FROM secrets --')",
    "SELECT $1::1lower('x) FROM secrets --')",
    // A suffix that never closes.
    "SELECT name, :a(x",
    // SQLite reads `[` to the first `]` as a name, whatever is in between.
    "SELECT ['] FROM secrets --'] FROM leads",
    'SELECT ["] FROM secrets --"] FROM leads',
    "SELECT [-- ] FROM secrets",
    "SELECT [/*] FROM secrets */] FROM leads",
    // Postgres calls a function after `@` (an operator) or after `:` in a slice; a name read
    // as a placeholder must not hide the call.
    "SELECT @setval('s', 1) FROM leads",
    "SELECT @setval ('s', 1) FROM leads",
    "SELECT tags[1:setval('s', 1)] FROM leads",
    "SELECT tags[1:setval ('s', 1)] FROM leads",
    "SELECT ?setval('s', 1) FROM leads",
    "SELECT 1(2) FROM leads",
  ])("unknown: %j", (sql) => {
    expect(sqlTables(sql)).toBeUndefined();
  });

  // mysql2's query() pastes each value into the text at its `?` (and, with namedPlaceholders,
  // at each `:name`), and older versions do it inside strings, names, and comments too. A value
  // pasted there can end the string and run as SQL, so a placeholder inside one is unknown.
  describe("SQL the client fills in with values", () => {
    it.each([
      "SELECT '?' FROM leads",
      "SELECT `?` FROM leads",
      'SELECT "?" FROM leads',
      "SELECT 1 /* ? */ FROM leads",
      "SELECT 1 -- ?\nFROM leads",
      // named-placeholders skips '...' and "..." only, so it fills in these.
      "SELECT `:a` FROM leads",
      "SELECT 1 /* :a */ FROM leads",
      // Its quote tracking starts a string at the apostrophe in the comment, so it ends one
      // where the string really starts, and fills in `:a` inside it.
      "/* it's */ SELECT * FROM leads WHERE x = ':a'",
      "/* \\\\' */ SELECT * FROM leads WHERE x = ':a'",
      // It reads a backslash as escaping the next character, even in a comment: this
      // apostrophe starts no string there, so it fills in the `:a` in the next comment.
      "/* \\' */ SELECT * FROM leads /* :a */",
    ])("unknown: %j", (sql) => {
      expect(sqlTables(sql, { formatted: true })).toBeUndefined();
      expect(sqlTables(sql)).toBeDefined();
    });

    it.each([
      ["SELECT * FROM leads WHERE id = ? AND note = '12:30'", ["leads"]],
      ["SELECT * FROM leads WHERE created > '10:30' AND id = :id", ["leads"]],
      ['SELECT ":a" FROM leads', ["leads"]],
      // A doubled quote doesn't end the string, for named-placeholders either.
      ["SELECT * FROM leads WHERE note = 'it''s :x' AND id = ?", ["leads"]],
    ])("%j reads %j", (sql, read) => {
      expect(sqlTables(sql, { formatted: true })).toEqual({ read, write: [] });
    });
  });

  it("gives up on deeply nested SQL instead of overflowing the stack", () => {
    for (const depth of [100, 10_000]) {
      expect(sqlTables(`SELECT ${"(".repeat(depth)}1${")".repeat(depth)} FROM leads`)).toBeUndefined();
      expect(sqlTables(`SELECT * FROM leads WHERE id IN ${"(SELECT id FROM leads WHERE id IN ".repeat(depth)}(1)${")".repeat(depth)}`)).toBeUndefined();
    }
  });
});

describe("Drizzle fragments: a whole statement, or an expression", () => {
  it.each([
    ["SELECT 1", true],
    ["  with x as (select 1) select * from x", true],
    ["-- note\nDELETE FROM a", true],
    ["/* a */ /* b */\n-- c\nINSERT INTO a VALUES (1)", true],
    ["/**/UPDATE a SET b = 1", true],
    ["lower(name)", false],
    ["-- only a comment", false],
    ["/* never closed SELECT", false],
    ["/*/ SELECT */ x", false],
    ["selection", false],
  ])("%j is a statement: %s", (text, expected) => {
    expect(isStatement(text)).toBe(expected);
  });

  // Code scanning found the old regular expression could backtrack exponentially on this shape,
  // and PermLang reads code from pull requests: it must stay linear.
  it("reads a fragment built to make a regular expression backtrack, quickly", () => {
    const start = performance.now();
    expect(isStatement(`/*${"*//*".repeat(100_000)}`)).toBe(false);
    expect(isStatement(`${"-- x\n".repeat(100_000)}SELECT 1`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
