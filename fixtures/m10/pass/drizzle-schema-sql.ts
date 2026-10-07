import { Name, StringChunk, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { index, pgTable, text } from "drizzle-orm/pg-core";

// Runtime defaults that return values, not SQL, add nothing to an insert or update.
const leads = pgTable("leads", {
  id: text("id").$defaultFn(() => "generated"),
  touched: text("touched").$onUpdateFn(() => String(Date.now())),
  slug: text("slug").default(sql`gen_random_uuid()`),
  // SQL with no table in it, which the insert or update then holds.
  uid: text("uid").$defaultFn(() => sql`gen_random_uuid()`),
  seen: text("seen").$onUpdate(() => sql`current_timestamp`),
});
const db = drizzle("postgres://localhost/app");

/** @perm db.read(leads), db.write(leads) */
export async function write() {
  await db.insert(leads).values({ id: "1" });
  await db.update(leads).set({ id: "2" }).where(sql`${leads.id} = ${"1"}`);
  // A chunk of literal text that names no table, a column's name, and drizzle's own SQL nested.
  return db.select().from(leads).where(sql`${new StringChunk("1 = 1")} AND ${leads.id.name} IS NOT NULL AND ${sql`true`}`);
}

// Properties of the project's own objects that share a schema property's name.
/** @perm db.read(leads) */
export function lookalikes(form: { value: string; where: string; default: number }) {
  const { value, where } = form;
  return db.select().from(leads).where(sql`${leads.id} = ${value} OR ${where} = ${form.default}`);
}

// A named function returning a value, a runtime default with no function (which TypeScript
// rejects), and a table with no columns: nothing to put into a statement.
declare function makeId(): string;
const tickets = pgTable("tickets", { id: text("id").$defaultFn(makeId), note: text("note").$defaultFn() });
const loose = pgTable("loose");

/** @perm db.write(tickets), db.write(loose) */
export async function quiet() {
  await db.insert(tickets).values({});
  await db.insert(loose).values({});
  // A name on its own, and drizzle's own pieces joined, touch nothing.
  return [new Name("leads"), sql.join([sql`a`, sql`b`], sql`, `)];
}

// A schema property whose type refers to itself and holds no SQL.
/** @perm db.read(leads) */
export function indexUsing() {
  return [index("by_id").on(leads.id).config.using, db.select().from(leads)];
}
