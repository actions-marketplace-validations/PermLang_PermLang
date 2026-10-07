import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { colsB } from "./b.js";

// Column groups that spread each other: each is read once, and the cycle ends.
export const colsA = { ...colsB, a: text("a").$defaultFn(() => sql`(SELECT 1 FROM cycle_source)`) };
const cyclic = pgTable("cyclic", { ...colsA });
const db = drizzle("postgres://localhost/app");

/** @perm db.write(cyclic) */
export async function insertCyclic() {
  await db.insert(cyclic).values({}); // expect: error PERM001 db.read(cycle_source)
}
