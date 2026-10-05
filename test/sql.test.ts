// Reading table names out of literal SQL, for raw-SQL database clients.
//
// The reader fails closed: it gives a definite answer only for statement shapes it
// fully understands, and `undefined` (unknown) for everything else. Unknown SQL
// needs bare db.read and db.write. A wrong "safe" answer is a silent pass.

import { describe, expect, it } from "vitest";
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
  ])("unknown: %j", (sql) => {
    expect(sqlTables(sql)).toBeUndefined();
  });
});
