import mysql from "mysql2";
import { createPool } from "mysql2/promise";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import postgres from "postgres";

const sql = postgres("postgres://localhost/app");
const nsql = neon("postgres://localhost/app");
const pool = new Pool();
const my = mysql.createPool("mysql://localhost/app");
const myp = createPool("mysql://localhost/app");

// Found in the third review: query forms that ran SQL the checker didn't read.
/** @perm db.read(leads) */
export async function forms(override: { text: string }, options: { sql: string }) {
  // Neon before 1.0 runs SQL text passed to the query function itself.
  await nsql("DELETE FROM users"); // expect: error PERM001 db.write(users)
  // A spread after the SQL can replace it.
  await pool.query({ text: "SELECT * FROM leads", ...override }); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query({ sql: "SELECT * FROM leads", ...options }); // expect: error PERM001 db.read expect: error PERM001 db.write
  // So can a second key: the last one wins.
  await myp.query({ sql: "SELECT * FROM leads", sql: "DELETE FROM users" }); // expect: error PERM001 db.read expect: error PERM001 db.write
  // mysql2 pastes a value's toSqlString() into the SQL.
  await myp.query("SELECT * FROM leads WHERE id = ?", [{ toSqlString: () => "(SELECT max(id) FROM secrets)" }]); // expect: error PERM001 db.read expect: error PERM001 db.write
  my.query("SELECT * FROM leads WHERE id = ?", [mysql.raw("(SELECT max(id) FROM secrets)")]); // expect: error PERM001 db.read expect: error PERM001 db.write
  // ...also in a named placeholder, a bulk insert's rows, or an options object's values.
  await myp.query("SELECT * FROM leads WHERE id = :id", { id: mysql.raw("1") }); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("INSERT INTO leads (a, b) VALUES ?", [[[1, mysql.raw("(SELECT 1 FROM secrets)")]]]); // expect: error PERM001 db.read expect: error PERM001 db.write
  const values = [mysql.raw("(SELECT 1 FROM secrets)")];
  await myp.query({ sql: "SELECT * FROM leads WHERE id = ?", values }); // expect: error PERM001 db.read expect: error PERM001 db.write
  // An array made to look like a template's strings runs as a query.
  const strings = Object.assign(["DELETE FROM users"], { raw: ["DELETE FROM users"] });
  await sql(strings as any); // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql(strings as unknown); // expect: error PERM001 db.read expect: error PERM001 db.write
  await nsql(strings as unknown as TemplateStringsArray); // expect: error PERM001 db.read expect: error PERM001 db.write
  const hidden = (): object => strings;
  await nsql(hidden() as never); // expect: error PERM001 db.read expect: error PERM001 db.write
  // Text that isn't a constant: a parameter named in shorthand.
  await ((text: string) => pool.query({ text }))("SELECT 1"); // expect: error PERM001 db.read expect: error PERM001 db.write
  // A query method passed along runs whatever SQL it's given.
  [strings].forEach(pool.query); // expect: error PERM001 db.read expect: error PERM001 db.write
}
