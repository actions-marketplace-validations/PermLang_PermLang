import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { alias, pgSchema, pgTable, pgTableCreator, text } from "drizzle-orm/pg-core";

const db = drizzle("postgres://localhost/app");
const leads = pgTable("leads", { id: text("id") });

// Found in the second review: table names that were guessed wrong.
const secrets = pgSchema("private").table("secrets", { key: text("key") });
const dynamicName = pgTable(process.env.TABLE_NAME ?? "x", { id: text("id") }); // expect: error PERM003 env(TABLE_NAME)
const createTable = pgTableCreator((name) => `app_${name}`);
const things = createTable("things", { id: text("id") });
const leadsAgain = alias(leads, "l2");
let reassignable = pgTable("leads", { id: text("id") }); // could be any table by the time it is used

/** @perm db.read(leads) */
export async function names() {
  await db.select().from(secrets); // expect: error PERM001 db.read(private.secrets)
  await db.insert(dynamicName).values({ id: "1" }); // expect: error PERM001 db.write
  await db.select().from(things); // expect: error PERM001 db.read
  await db.select().from(leadsAgain);
  await db.select().from(reassignable); // expect: error PERM001 db.read
}

// Relations: nested ones are read, and options that aren't written out could load any.
/** @perm db.read(leads) */
export async function relations(options: object) {
  await db.query.leads!.findMany({ with: { posts: { with: { comments: true } } } }); // expect: error PERM001 db.read(posts) expect: error PERM001 db.read(comments)
  await db.query.leads!.findMany(options); // expect: error PERM001 db.read
}

/** @perm db.read(leads) */
export async function relationByKey() {
  await db.query["secrets"]!.findMany(); // expect: error PERM001 db.read(secrets)
}

/** @perm db.read(leads) */
export async function relationsSpread(rels: Record<string, true>) {
  await db.query.leads!.findMany({ with: { ...rels } }); // expect: error PERM001 db.read
}

/** @perm db.read(leads) */
export async function relationsVariable(rels: Record<string, true>) {
  await db.query.leads!.findMany({ with: rels }); // expect: error PERM001 db.read
}

/** @perm db.read(leads), db.read(posts) */
export async function relationsNestedVariable(nested: object) {
  await db.query.leads!.findMany({ with: { posts: nested } }); // expect: error PERM001 db.read
}

/** @perm db.read(leads) */
export async function columnsOnly() {
  await db.query.leads!.findMany({ columns: { id: true } });
}

/** @perm db.read(leads) */
export async function migrations() {
  await migrate(db, { migrationsFolder: "./drizzle" }); // expect: error PERM001 db.read expect: error PERM001 db.write
}
