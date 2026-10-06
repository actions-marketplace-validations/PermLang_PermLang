// Minimal stand-ins for raw-SQL clients, shaped like their real typings
// (@types/pg, mysql2, @types/better-sqlite3, postgres).
declare module "pg" {
  export class Pool {
    query(text: string, values?: unknown[]): Promise<unknown>;
    query(config: { text: string; values?: unknown[] }): Promise<unknown>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
  export interface PoolClient {
    query(text: string, values?: unknown[]): Promise<unknown>;
    copyFrom(text: string): unknown;
    release(): void;
  }
}

declare module "mysql2/promise" {
  export interface Pool {
    query(sql: string, values?: unknown[]): Promise<unknown>;
    query(options: { sql: string; values?: unknown[] }): Promise<unknown>;
    execute(sql: string, values?: unknown[]): Promise<unknown>;
  }
  export function createPool(uri: string): Pool;
}

declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  class Database {
    constructor(file: string);
    prepare(source: string): Statement;
    exec(source: string): this;
    pragma(source: string): unknown;
    loadExtension(path: string): this;
    backup(destination: string): Promise<unknown>;
    close(): this;
  }
  export default Database;
}

declare module "mysql2" {
  import type { Pool as PromisePool } from "mysql2/promise";
  export interface Pool {
    query(sql: string, values?: unknown[]): unknown;
    promise(): PromisePool;
  }
  export function createPool(uri: string): Pool;
  // mysql2 re-exports its escaping helpers from sql-escaper.
  export { raw } from "sql-escaper";
}

declare module "sql-escaper" {
  export function raw(sql: string): { toSqlString(): string };
}

declare module "@neondatabase/serverless" {
  // Before 1.0, the query function also took SQL text called as a function.
  export interface NeonQueryFunction {
    (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]>;
    (query: string, params?: unknown[]): Promise<unknown[]>;
  }
  export function neon(url: string): NeonQueryFunction;
}

declare module "postgres" {
  export interface Helper {
    readonly value: unknown;
  }
  // Modifiers on a query, which run the SQL its tag already names.
  interface PendingQuery extends Promise<unknown[]> {
    values(): PendingQuery;
    raw(): PendingQuery;
    simple(): PendingQuery;
    execute(): PendingQuery;
    describe(): Promise<unknown>;
    cursor(rows?: number): AsyncIterable<unknown[]>;
  }
  interface Sql {
    // Like postgres.js 3.4, the helper overload comes first.
    (name: string): Helper;
    (strings: TemplateStringsArray, ...values: unknown[]): PendingQuery;
    unsafe(query: string): Promise<unknown[]>;
    file(path: string): Promise<unknown[]>;
    end(): Promise<void>;
  }
  function postgres(url?: string): Sql;
  export default postgres;
}
