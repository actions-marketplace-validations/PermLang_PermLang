import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { check, index, pgTable, text } from "drizzle-orm/pg-core";

// Schema definitions hold SQL that runs inside the database, not in a query here.
const leads = pgTable(
  "leads",
  { id: text("id").default(sql`gen_random_uuid()`), name: text("name"), slug: text("slug").generatedAlwaysAs(sql`lower(name)`), hash: text("hash").generatedAlwaysAs(() => sql`md5(name)`) },
  (t) => [check("short", sql`octet_length(${t.name}) < 100`), index("by_name").on(t.name).where(sql`${t.name} IS NOT NULL`)],
);
const db = drizzle("postgres://localhost/app");
const recent = sql`${leads} IS NOT NULL AND now() > now() - interval '1 day'`;

// Fragments over the query's own table, with values, columns, and harmless functions.
/** @perm db.read(leads) */
export async function harmless(id: string) {
  await db.select({ n: sql`count(*)`, upper: sql`upper(${leads.name})`.as("upper") }).from(leads).where(recent);
  await db.select().from(leads).where(eq(leads.id, id)).orderBy(sql`${leads.name} DESC NULLS LAST`, sql.raw("1"));
  return db.select().from(leads).where(sql`lower(${leads.name}) = ${id} AND coalesce(${leads.id}, '') <> ''`);
}
