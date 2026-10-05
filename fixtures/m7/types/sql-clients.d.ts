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

declare module "postgres" {
  export interface Helper {
    readonly value: unknown;
  }
  interface Sql {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    (name: string): Helper;
    unsafe(query: string): Promise<unknown[]>;
    file(path: string): Promise<unknown[]>;
    end(): Promise<void>;
  }
  function postgres(url?: string): Sql;
  export default postgres;
}
