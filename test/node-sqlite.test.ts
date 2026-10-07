// Node's own SQLite client, node:sqlite (Node 22.5 and later), checked against the
// project's own @types/node (24): DatabaseSync and StatementSync take SQL text like
// better-sqlite3's, and a tag store runs tagged templates. Before, it was only listed
// as a package with no adapter.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
let dir: string;
let report: Report;

const APP = `
import { DatabaseSync, backup } from "node:sqlite";
import { Database } from "sqlite";
const db = new DatabaseSync("app.db");

export function read(id: number) { return db.prepare("SELECT * FROM leads WHERE id = ?").get(id); }
export function write() { db.exec("DELETE FROM sessions"); }
export function statement() { const s = db.prepare("SELECT name FROM leads"); return [s.all(), s.get(), s.run(), s.columns(), s.sourceSQL]; }
export function tagged(id: number) { const sql = db.createTagStore(); return [sql.all\`SELECT * FROM leads WHERE id = \${id}\`, sql.run\`UPDATE leads SET seen = 1\`]; }
export function unknownText(text: string) { return db.prepare(text).all(); }
export function forgedTemplate(strings: TemplateStringsArray) { return db.createTagStore().all(strings); }
export function asValue(texts: string[]) { return texts.map(db.exec); }
export function extension() { db.loadExtension("./evil.so"); }
export function copy() { return [db.serialize(), backup(db, "copy.db")]; }
export function replace(data: Uint8Array) { db.deserialize(data); return db.applyChangeset(data); }
export function session() { const s = db.createSession(); return [s.changeset(), s.close()]; }
export function lifecycle() { db.function("double", (x) => Number(x) * 2); db.enableDefensive(true); db.createTagStore().clear(); db.close(); db.open(); return [db.isOpen, db.location()]; }
export function cast() { return (db as any).exec("DELETE FROM secrets"); }
export function npmSqlite(other: Database) { return other.exec("DELETE FROM secrets"); }
`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-node-sqlite-"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, lib: ["ES2022"], types: ["node"], typeRoots },
      include: ["*.ts"],
    }),
    "app.ts": APP,
    // The npm package called sqlite (a wrapper around sqlite3) is another client, with no adapter.
    "node_modules/sqlite/package.json": JSON.stringify({ name: "sqlite", types: "index.d.ts" }),
    "node_modules/sqlite/index.d.ts": "export declare class Database { exec(sql: string): Promise<void>; }",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  report = checkTsConfig(path.join(dir, "tsconfig.json"));
});

afterAll(() => removeTemporary(dir));

function actual(name: string): string[] {
  const fn = report.functions.find((f) => f.name === name);
  return fn ? [...fn.actual].sort() : [];
}

describe("node:sqlite", () => {
  it.each([
    ["read", ["db.read(leads)"]],
    ["write", ["db.write(sessions)"]],
    // A prepared statement runs the SQL prepare() was given.
    ["statement", ["db.read(leads)"]],
    // A tag store's tagged templates bind their substitutions as parameters.
    ["tagged", ["db.read(leads)", "db.write(leads)"]],
    ["unknownText", ["db.read", "db.write"]],
    // Called as a function, with an array made to look like a template's strings.
    ["forgedTemplate", ["db.read", "db.write"]],
    ["asValue", ["db.read", "db.write"]],
    ["extension", ["unverifiable"]],
    ["copy", ["db.read", "fs.write"]],
    ["replace", ["db.read", "db.write"]],
    ["session", ["db.read"]],
    ["lifecycle", []],
    // Cast to any, a client is still followed by the members read off the cast.
    ["cast", ["db.write(secrets)"]],
  ])("%s", (name, expected) => {
    expect(actual(name)).toEqual(expected);
  });

  it("is detected, not listed as a package with no adapter; the npm package called sqlite still is", () => {
    expect(report.unmapped.map((u) => u.package)).toEqual(["sqlite"]);
    expect(report.unmapped[0]!.line).toBe(APP.split("\n").findIndex((l) => l.includes("npmSqlite")) + 1);
    expect(actual("npmSqlite")).toEqual([]);
  });
});
