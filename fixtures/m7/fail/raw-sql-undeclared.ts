import Database from "better-sqlite3";
import { createPool } from "mysql2/promise";
import { Pool } from "pg";
import postgres from "postgres";

const pool = new Pool();
const mysql = createPool("mysql://localhost/app");
const sqlite = new Database("app.db");
const sql = postgres("postgres://localhost/app");

/** @perm db.read(leads) */
export async function cleanup(table: string, id: string) {
  await pool.query("DELETE FROM sessions WHERE expires < now()"); // expect: error PERM001 db.write(sessions)
  await mysql.execute("SELECT * FROM orders"); // expect: error PERM001 db.read(orders)
  sqlite.exec("DROP TABLE IF EXISTS staging"); // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql`UPDATE leads SET seen = true WHERE id = ${id}`; // expect: error PERM001 db.write(leads)
  // SQL built from strings can touch any table, and is how injection happens.
  await pool.query(`SELECT * FROM ${table}`); // expect: error PERM001 db.read expect: error PERM001 db.write
  await sql.unsafe(`DELETE FROM ${table}`); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// The same queries as config objects: pg's { text }, mysql2's { sql }.
/** @perm db.read(leads) */
export async function configs() {
  await pool.query({ text: "DELETE FROM audit WHERE id = $1", values: [1] }); // expect: error PERM001 db.write(audit)
  await mysql.query({ sql: "SELECT * FROM payroll" }); // expect: error PERM001 db.read(payroll)
}
