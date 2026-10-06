import mysql from "mysql2";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";
import postgres from "postgres";

const sql = postgres("postgres://localhost/app");
const pool = new Pool();
const my = mysql.createPool("mysql://localhost/app");
const myp = createPool("mysql://localhost/app");

// Found in the third review: these were reported as touching any table.
/** @perm db.read(leads) */
export async function modifiers() {
  await sql`SELECT * FROM leads`.values();
  await sql`SELECT * FROM leads`.simple().execute();
  await sql`SELECT * FROM leads`.describe();
  for await (const rows of sql`SELECT * FROM leads`.cursor(100)) void rows;
  await my.promise().query("SELECT * FROM leads");
}

// Plain values, written-out config objects, and postgres.js helpers outside a query.
/** @perm db.read(leads), db.write(leads) */
export async function plain(id: number) {
  await myp.query("SELECT * FROM leads WHERE id = ?", [id, new Date()]);
  await myp.query("SELECT * FROM leads WHERE id = :id OR owner = :owner", { id, owner: id });
  await myp.query("INSERT INTO leads (a, b) VALUES ?", [[[1, 2], [3, 4]]]);
  await myp.query({ sql: "SELECT * FROM leads WHERE id = ?", values: [id] });
  await myp.query({ "sql": "SELECT * FROM leads" });
  const text = "SELECT * FROM leads WHERE id = $1";
  await pool.query({ text, values: [id] });
  sql();
  return sql("leads");
}

// The client passed along is checked where it's called.
class Repo {
  constructor(private readonly db: typeof sql) {}
  /** @perm db.read(leads) */
  all() { return this.db`SELECT * FROM leads`; }
}
/** @perm db.read(leads) */
export function repo() { return new Repo(sql).all(); }
