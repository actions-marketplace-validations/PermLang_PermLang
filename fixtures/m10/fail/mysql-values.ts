import { createPool } from "mysql2/promise";

const myp = createPool("mysql://localhost/app");

interface Lead {
  name: string;
}

// Found in the fourth review: mysql2's query() pastes a value's toSqlString() into the SQL,
// and a value whose type doesn't rule that method out could have one. An interface or an
// object type lists some of an object's members, not all of them.
/** @perm db.read(leads) */
export async function values(a: unknown, b: object, c: Lead, d: unknown[], e: Record<string, unknown>, f: any, g: { id: number }) {
  await myp.query("SELECT * FROM leads WHERE id = ?", [a]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", [b]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", [c]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", d); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", [e]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", [f]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE ?", [g]); // expect: error PERM001 db.read expect: error PERM001 db.write
  // A cast doesn't change the value.
  await myp.query("SELECT * FROM leads WHERE id = ?", [a as number]); // expect: error PERM001 db.read expect: error PERM001 db.write
  // An object literal with the method itself, and values spread in from a list of anything.
  await myp.query("SELECT * FROM leads WHERE id = ?", [{ toSqlString() { return "(SELECT 1 FROM secrets)"; } }]); // expect: error PERM001 db.read expect: error PERM001 db.write
  await myp.query("SELECT * FROM leads WHERE id = ?", [...d]); // expect: error PERM001 db.read expect: error PERM001 db.write
}

/** @perm db.read(leads) */
export async function generic<T>(value: T) {
  await myp.query("SELECT * FROM leads WHERE id = ?", [value]); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// A helper that takes any value, and a caller that hands it SQL.
function findLead(id: unknown) {
  return myp.query("SELECT name FROM leads WHERE id = ?", [id]);
}
/** @perm db.read(leads) */
export function leak() {
  return findLead({ toSqlString: () => "(SELECT password FROM users LIMIT 1)" }); // expect: error PERM001 db.read expect: error PERM001 db.write
}
