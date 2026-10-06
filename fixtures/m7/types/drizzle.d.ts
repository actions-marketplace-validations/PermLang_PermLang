// Minimal stand-in for drizzle-orm, shaped like its real typings (verified against
// drizzle-orm's pg-core: PgDatabase, PgSelectBuilder, RelationalQueryBuilder, pgTable).
declare module "drizzle-orm/pg-core" {
  export interface PgTable {
    readonly _: { name: string };
  }
  export const pgTable: (name: string, columns: Record<string, unknown>, extra?: (t: Record<string, unknown>) => unknown[]) => PgTable;
  export function text(name?: string): PgColumnBuilder;
  // Schema definitions that take SQL: defaults, generated columns, checks, partial indexes.
  export class PgColumnBuilder {
    default(value: unknown): this;
    generatedAlwaysAs(as: unknown): this;
  }
  export class IndexBuilder {
    where(condition: unknown): this;
  }
  export function index(name: string): { on(...columns: unknown[]): IndexBuilder };
  export function check(name: string, value: unknown): unknown;
  export class PgSchema {
    table(name: string, columns: Record<string, unknown>): PgTable;
  }
  export function pgSchema(name: string): PgSchema;
  export function pgTableCreator(customize: (name: string) => string): typeof pgTable;
  export function alias<T extends PgTable>(table: T, name: string): T;

  // Like the real typings, joins are function-typed properties, not methods.
  type PgSelectJoinFn = (table: PgTable, on: unknown) => PgSelect;
  export class PgSelect {
    leftJoin: PgSelectJoinFn;
    innerJoin: PgSelectJoinFn;
    where(condition: unknown): PgSelect;
    orderBy(...columns: unknown[]): PgSelect;
    then<R>(onfulfilled: (value: unknown[]) => R): Promise<R>;
  }
  export class PgSelectBuilder {
    from(table: PgTable): PgSelect;
  }
  export class PgInsertBuilder {
    values(rows: object): Promise<unknown>;
  }
  export class PgUpdateBuilder {
    set(values: object): { where(condition: unknown): Promise<unknown> };
  }
  export class RelationalQueryBuilder {
    findMany(config?: object): Promise<unknown[]>;
    findFirst(config?: object): Promise<unknown>;
  }
  export class PgDatabase {
    query: Record<string, RelationalQueryBuilder>;
    select(fields?: Record<string, unknown>): PgSelectBuilder;
    insert(table: PgTable): PgInsertBuilder;
    update(table: PgTable): PgUpdateBuilder;
    delete(table: PgTable): { where(condition: unknown): Promise<unknown> };
    execute(query: unknown): Promise<unknown>;
  }
}

declare module "drizzle-orm/node-postgres" {
  import type { PgDatabase } from "drizzle-orm/pg-core";
  export function drizzle(url: string): PgDatabase;
}

declare module "drizzle-orm/node-postgres/migrator" {
  import type { PgDatabase } from "drizzle-orm/pg-core";
  export function migrate(db: PgDatabase, config: { migrationsFolder: string }): Promise<void>;
}

declare module "drizzle-orm" {
  export function eq(left: unknown, right: unknown): unknown;
  export class SQL {
    as(alias: string): this;
  }
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): SQL;
  export namespace sql {
    function raw(str: string): SQL;
    function identifier(value: string): SQL;
  }
}
