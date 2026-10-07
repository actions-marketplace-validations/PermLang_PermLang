import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { alias, pgTable, text } from "drizzle-orm/pg-core";

declare const flag: boolean;
declare const shared: SQL;
declare const registry: any;
declare function makeSql(): SQL;
declare function declaredColumns(): Record<string, unknown>;

const db = drizzle("postgres://localhost/app");

// What a runtime default's function returns, however the function is written.
const eventsSqlFn = pgTable("events_sql_fn", { a: text("a").$defaultFn(makeSql) }); // a function defined elsewhere that returns SQL
const eventsBlock = pgTable("events_block", {
  a: text("a").$defaultFn(function () {
    return sql`(SELECT max(x) FROM vault)`;
  }),
  b: text("b").$onUpdate(() => {
    if (flag) return;
    return sql`(SELECT 1 FROM ledger)`;
  }),
});
// A named function returning SQL: the code that hands it to $defaultFn reaches it, and the
// inserts can't read what it returns.
function namedDefault() {
  return sql`(SELECT max(k) FROM secrets)`;
}
const eventsNamed = pgTable("events_named", { a: text("a").$defaultFn(namedDefault) }); // expect: error PERM003 db.read(secrets)
const eventsShared = pgTable("events_shared", { a: text("a").$defaultFn(() => shared) }); // SQL that can't be read
const eventsMaybe = pgTable("events_maybe", { a: text("a").$defaultFn(() => (flag ? "x" : sql`now()`)) });
const eventsAny = pgTable("events_any", { a: text("a").$defaultFn(() => (globalThis as any).makeDefault()) });

// Where a table's columns come from: written in place, in a const, or spread in.
const auditColumns = { by: text("by").$defaultFn(() => sql`(SELECT name FROM staff LIMIT 1)`) };
const auditConst = pgTable("audit_const", auditColumns);
const cbArrow = pgTable("cb_arrow", (t: unknown) => ({ id: text("id").$defaultFn(() => sql`(SELECT 1 FROM clock)`) }));
const cbFunction = pgTable("cb_function", function () {
  return { id: text("id").$defaultFn(() => sql`(SELECT 1 FROM tick)`) };
});
const colsDeclared = pgTable("cols_declared", declaredColumns());
const spreadConditional = pgTable("spread_conditional", { ...(flag ? auditColumns : {}) });
const spreadLibrary = pgTable("spread_library", { ...Object.fromEntries([["id", text("id")]]) });
const spreadUnresolved = pgTable("spread_unresolved", { ...registry.columns() });
const mkCols = () => ({ x: text("x").$defaultFn(() => sql`(SELECT 1 FROM vault2)`) });
const mkCols2 = function () {
  return { y: text("y").$defaultFn(() => sql`(SELECT 1 FROM vault3)`) };
};
function sharedCols() {
  return auditColumns;
}
function partialCols() {
  if (flag) return;
  return { z: text("z") };
}
const spreadArrow = pgTable("spread_arrow", { ...mkCols() });
const spreadFn = pgTable("spread_fn", { ...mkCols2() });
const spreadShared = pgTable("spread_shared", { ...sharedCols() });
const spreadPartial = pgTable("spread_partial", { ...partialCols() });
// More column groups than PermLang reads.
const w1 = { w1: text("w1") }, w2 = { w2: text("w2") }, w3 = { w3: text("w3") }, w4 = { w4: text("w4") }, w5 = { w5: text("w5") }, w6 = { w6: text("w6") };
const w7 = { w7: text("w7") }, w8 = { w8: text("w8") }, w9 = { w9: text("w9") }, w10 = { w10: text("w10") }, w11 = { w11: text("w11") }, w12 = { w12: text("w12") };
const w13 = { w13: text("w13") }, w14 = { w14: text("w14") }, w15 = { w15: text("w15") }, w16 = { w16: text("w16") }, w17 = { w17: text("w17") };
const wide = pgTable("wide", { ...w1, ...w2, ...w3, ...w4, ...w5, ...w6, ...w7, ...w8, ...w9, ...w10, ...w11, ...w12, ...w13, ...w14, ...w15, ...w16, ...w17 });

/**
 * @perm db.write(events_sql_fn), db.write(events_block), db.write(events_named), db.write(events_shared), db.write(events_maybe), db.write(events_any),
 *   db.write(audit_const), db.write(cb_arrow), db.write(cb_function), db.write(cols_declared), db.write(spread_conditional),
 *   db.write(spread_library), db.write(spread_unresolved), db.write(spread_arrow), db.write(spread_fn), db.write(spread_shared),
 *   db.write(spread_partial), db.write(wide)
 */
export async function inserts() {
  await db.insert(eventsSqlFn).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(eventsBlock).values({}); // expect: error PERM001 db.read(vault) expect: error PERM001 db.read(ledger)
  await db.insert(eventsNamed).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(eventsShared).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(eventsMaybe).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(eventsAny).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(auditConst).values({}); // expect: error PERM001 db.read(staff)
  await db.insert(cbArrow).values({}); // expect: error PERM001 db.read(clock)
  await db.insert(cbFunction).values({}); // expect: error PERM001 db.read(tick)
  await db.insert(colsDeclared).values({}); // expect: error PERM001 db.read
  await db.insert(spreadConditional).values({}); // expect: error PERM001 db.read
  await db.insert(spreadLibrary).values({}); // expect: error PERM001 db.read
  await db.insert(spreadUnresolved).values({}); // expect: error PERM001 db.read
  await db.insert(spreadArrow).values({}); // expect: error PERM001 db.read(vault2)
  await db.insert(spreadFn).values({}); // expect: error PERM001 db.read(vault3)
  await db.insert(spreadShared).values({}); // expect: error PERM001 db.read
  await db.insert(spreadPartial).values({}); // expect: error PERM001 db.read
  await db.insert(wide).values({}); // expect: error PERM001 db.read
}

// Tables PermLang can't trace to their definition: a name that's too deeply aliased, one
// from an untyped registry, and one a function of the project's makes.
const leads = pgTable("leads", { id: text("id") });
const fromRegistry = registry.table("x");
function makeTable() {
  return pgTable("made", { id: text("id") });
}

/** @perm db.read(leads) */
export async function untraced() {
  await db.select().from(alias(alias(alias(alias(alias(alias(leads, "a"), "b"), "c"), "d"), "e"), "f")); // expect: error PERM001 db.read
  await db.insert(fromRegistry).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
  await db.insert(makeTable()).values({}); // expect: error PERM001 db.read expect: error PERM001 db.write
}
