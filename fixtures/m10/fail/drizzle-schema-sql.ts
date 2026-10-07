import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { check, pgPolicy, pgTable, text } from "drizzle-orm/pg-core";

// Found in the fourth review. Drizzle calls a column's $defaultFn when it builds an
// insert, and $onUpdateFn when it builds an update (or an insert, without a default),
// and puts the SQL they return into the statement.
const leads = pgTable("leads", {
  id: text("id"),
  score: text("score").$defaultFn(() => sql`(SELECT max(k) FROM secrets)`),
  touched: text("touched").$onUpdate(() => sql`(SELECT count(*) FROM audit_log)`),
});
const db = drizzle("postgres://localhost/app");

/** @perm db.write(leads) */
export async function insert() {
  await db.insert(leads).values({ id: "1" }); // expect: error PERM001 db.read(secrets) expect: error PERM001 db.read(audit_log)
}

/** @perm db.write(leads) */
export async function update() {
  await db.update(leads).set({ id: "2" }).where(sql`true`); // expect: error PERM001 db.read(audit_log)
}

// Columns spread in from a const, or from what a function returns, are read too.
const stamps = { stamped: text("stamped").$defaultFn(() => sql`(SELECT max(at) FROM clock)`) };
function audited() {
  return { by: text("by").$onUpdateFn(() => sql`(SELECT name FROM staff LIMIT 1)`) };
}
const notes = pgTable("notes", { id: text("id"), ...stamps, ...audited() });

/** @perm db.write(notes) */
export async function spread() {
  await db.insert(notes).values({ id: "1" }); // expect: error PERM001 db.read(clock) expect: error PERM001 db.read(staff)
}

// A table chosen at run time, or columns PermLang can't see, could have runtime defaults
// that read any table.
declare function moreColumns(): Record<string, unknown>;
const opaque = pgTable("opaque", { id: text("id"), ...moreColumns() });

/** @perm db.write */
export async function unseen(table: typeof leads) {
  await db.insert(table).values({ id: "1" }); // expect: error PERM001 db.read
  await db.update(opaque).set({ id: "1" }).where(sql`true`); // expect: error PERM001 db.read
}

// SQL a schema definition holds runs in the database, but read back out of it, it can
// run in a query.
/** @perm db.read(leads) */
export async function readBack() {
  await db.select().from(leads).where(check("x", sql`EXISTS (SELECT 1 FROM secrets)`).value); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(pgPolicy("leads_visible_only_to_their_owners", { using: sql`EXISTS (SELECT 1 FROM secrets)` }).using); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(leads.score["default"]); // expect: error PERM001 db.read expect: error PERM001 db.write
  const { withCheck } = pgPolicy("p", { withCheck: sql`EXISTS (SELECT 1 FROM secrets)` }); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(withCheck);
  return db.select().from(leads).where(leads.touched.defaultFn?.()); // expect: error PERM001 db.read expect: error PERM001 db.write
}
