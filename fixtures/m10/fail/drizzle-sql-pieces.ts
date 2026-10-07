import { SQL, StringChunk, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { index, pgTable, text } from "drizzle-orm/pg-core";

const leads = pgTable("leads", { id: text("id") });
const db = drizzle("postgres://localhost/app");

// Found in the fourth review: SQL put together from drizzle's own pieces, without
// sql`...` or sql.raw(), wasn't read at all.
/** @perm db.read(leads) */
export async function pieces(text: string) {
  // A chunk of text is pasted in as it is: literal text is read, anything else is unknown.
  const chunk = new StringChunk("EXISTS (SELECT 1 FROM secrets)"); // expect: error PERM001 db.read(secrets)
  await db.select().from(leads).where(sql`${new StringChunk(["(SELECT max(id) ", "FROM vault)"])} > 0`); // expect: error PERM001 db.read(vault)
  new StringChunk(text); // expect: error PERM001 db.read expect: error PERM001 db.write
  new StringChunk(["EXISTS (SELECT 1 FROM leads) OR ", text]); // expect: error PERM001 db.read expect: error PERM001 db.write
  // Made without a call that shows its text.
  Reflect.construct(StringChunk, [text]); // expect: error PERM001 db.read expect: error PERM001 db.write
  // SQL made from a list of pieces could hold any of them.
  await db.select().from(leads).where(new SQL([chunk])); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(sql.fromList([chunk])); // expect: error PERM001 db.read expect: error PERM001 db.write
  // An object of the project's own with getSQL() is pasted in as whatever SQL that returns.
  const wrapper = { getSQL: () => new SQL([]) };
  await db.select().from(leads).where(sql`${wrapper}`); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(new Condition()); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select({ n: new Condition() }).from(leads); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.select().from(leads).where(sql.join([new Condition(), sql`true`], sql` AND `)); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// An index's columns, read back out of it: drizzle's SQLChunk type refers to itself.
/** @perm db.read(leads) */
export async function indexColumns() {
  const byName = index("by_name").on(leads.id);
  await db.select().from(leads).orderBy(byName.config.columns[0]); // expect: error PERM001 db.read expect: error PERM001 db.write
}

class Condition {
  getSQL() {
    return new SQL([]);
  }
}
