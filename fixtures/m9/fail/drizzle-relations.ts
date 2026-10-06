import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle("postgres://localhost/app");

/** @perm db.read(leads) */
export async function relations(key: string) {
  // A key written as a string names the relation; a computed one could load any.
  await db.query.leads!.findMany({ with: { "owner": true } }); // expect: error PERM001 db.read(owner)
  await db.query.leads!.findMany({ with: { [key]: true } }); // expect: error PERM001 db.read
  const team = true;
  await db.query.leads!.findMany({ with: { team } }); // expect: error PERM001 db.read(team)
  // Nested deeper than any real query: what's below could load anything.
  await db.query.leads!.findMany({ with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: { with: { a: true } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } } }); // expect: error PERM001 db.read(a) expect: error PERM001 db.read
}
