import Database from "better-sqlite3";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";

const lite = new Database("app.db");
const myp = createPool("mysql://localhost/app");
const pool = new Pool();

// Found in the fourth review: MySQL and SQLite read `?` on its own, so `?FROM` is a
// placeholder and then FROM, which names a table.
/** @perm db.write(leads) */
export async function glued(tag: string) {
  await myp.execute("INSERT INTO leads (name) SELECT ?FROM secrets", [tag]); // expect: error PERM001 db.read(secrets)
  return lite.prepare("SELECT name, ?1FROM secrets").all(tag); // expect: error PERM001 db.read(secrets)
}

// SQLite reads `:a(...)` up to its `)` as one variable, and `[...]` as one name, so the
// quote inside them starts no string there.
/** @perm db.read(leads) */
export function sqliteTokens() {
  lite.prepare("SELECT :a('x) FROM secrets --')").all(); // expect: error PERM001 db.read expect: error PERM001 db.write
  return lite.prepare("SELECT ['] FROM secrets --'] FROM leads").all(); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// Postgres reads `@setval(...)` as the operator @ and a call of setval, which writes.
/** @perm db.read(leads) */
export function postgresCall() {
  return pool.query("SELECT @setval('seq', 1) FROM leads"); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// mysql2's query() pastes values in at each `?`, and older versions do it inside strings
// and comments too, where a value can end the string. execute() binds them on the server.
/** @perm db.read(leads) */
export async function filledIn(value: string) {
  await myp.query("SELECT '?' FROM leads", [value]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT 1 /* ? */ FROM leads", [value]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.execute("SELECT '?' FROM leads", [value]);
}

// A client cast to `any`: members read straight off the cast are looked up on its own type.
/** @perm db.read(leads) */
export async function cast(register: (value: unknown) => void) {
  await (pool as any).query("DELETE FROM secrets"); // expect: error PERM001 db.write(secrets)
  await (myp as unknown as { query(sql: string): Promise<unknown> }).query("SELECT * FROM secrets"); // expect: error PERM001 db.read(secrets)
  register(pool);
}
