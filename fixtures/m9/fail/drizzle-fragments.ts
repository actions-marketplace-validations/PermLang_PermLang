import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";

const keep = <T>(value: T) => value;

const leads = pgTable("leads", { id: text("id"), name: text("name") });
const secrets = pgTable("api_secrets", { key: text("key") });
const db = drizzle("postgres://localhost/app");

// Found in the third review: SQL written into a builder query wasn't read.
/** @perm db.read(leads) */
export async function fragments(id: string, filter: string) {
  await db.select().from(leads).where(sql`EXISTS (SELECT 1 FROM secrets)`); // expect: error PERM001 db.read(secrets)
  // A table substituted into the fragment is named by its definition.
  await db.select().from(leads).where(sql`${leads.id} IN (SELECT key FROM ${secrets})`); // expect: error PERM001 db.read(api_secrets)
  await db.select({ n: sql`(SELECT count(*) FROM payroll)` }).from(leads); // expect: error PERM001 db.read(payroll)
  await db.update(leads).set({ name: sql`(SELECT key FROM vault LIMIT 1)` }).where(eq(leads.id, id)); // expect: error PERM001 db.write(leads) expect: error PERM001 db.read(vault)
  // A function the reader doesn't know could touch any table.
  await db.select().from(leads).where(sql`purge_all_users() IS NULL`); // expect: error PERM001 db.read expect: error PERM001 db.write
  // sql.raw() pastes its text in: literal text is read, anything else is unknown.
  await db.select().from(leads).orderBy(sql.raw("(SELECT max(id) FROM audit)")); // expect: error PERM001 db.read(audit)
  await db.select().from(leads).where(sql.raw(filter)); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// A fragment is counted wherever it's written, unless a schema definition holds it.
/** @perm db.read(leads) */
export function elsewhere(strings: TemplateStringsArray, filters: string[]) {
  keep(sql`(SELECT 1 FROM vault1)`); // expect: error PERM001 db.read(vault1)
  (keep as any)(sql`(SELECT 1 FROM vault2)`); // expect: error PERM001 db.read(vault2)
  eq(leads.id, sql`(SELECT 1 FROM vault3)`); // expect: error PERM001 db.read(vault3)
  (() => sql`(SELECT 1 FROM vault4)`)(); // expect: error PERM001 db.read(vault4)
  pgTable("t", { a: text("a") }, () => [sql`(SELECT 1 FROM vault5)`]); // expect: error PERM001 db.read(vault5)
  // Called as a function, or passed along, sql and sql.raw can run anything.
  sql(strings as any); // expect: error PERM001 db.read expect: error PERM001 db.write
  return filters.map(sql.raw); // expect: error PERM001 db.read expect: error PERM001 db.write
}

// A whole statement is read as one: this one writes, on top of execute()'s unknown access.
/** @perm db.read(leads) */
export async function statement() {
  await db.execute(sql`DELETE FROM sessions`); // expect: error PERM001 db.read expect: error PERM001 db.write expect: error PERM001 db.write(sessions)
}
