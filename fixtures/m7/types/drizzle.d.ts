// Minimal stand-in for drizzle-orm, shaped like its real typings (verified against
// drizzle-orm's pg-core: PgDatabase, PgSelectBuilder, RelationalQueryBuilder, pgTable).
declare module "drizzle-orm/pg-core" {
  import type { Name, SQL, SQLChunk } from "drizzle-orm";
  export interface PgTable {
    readonly _: { name: string };
  }
  export const pgTable: <C extends Record<string, unknown>>(name: string, columns: C, extra?: (t: Record<string, unknown>) => unknown[]) => PgTable & { [K in keyof C]: PgColumn };
  export function text(name?: string): PgColumnBuilder;
  // Schema definitions that take SQL: defaults, generated columns, checks, partial indexes.
  export class PgColumnBuilder {
    default(value: unknown): this;
    generatedAlwaysAs(as: unknown): this;
    // Called when drizzle builds an insert (or update), which then holds what they return.
    $defaultFn(fn: () => string | SQL): this;
    $default: (fn: () => string | SQL) => this;
    $onUpdateFn(fn: () => string | SQL): this;
    $onUpdate: (fn: () => string | SQL) => this;
  }
  // A table's column keeps the SQL its definition was given.
  export class PgColumn {
    readonly name: string;
    readonly default: string | SQL | undefined;
    readonly defaultFn: (() => string | SQL) | undefined;
  }
  export class IndexBuilder {
    // What it was given. Drizzle has types that refer to themselves, as these do.
    readonly config: { columns: SQLChunk[]; where?: SQL; using: IndexUsing };
    where(condition: unknown): this;
  }
  export type IndexUsing = Name | IndexUsing[];
  export function index(name: string): { on(...columns: unknown[]): IndexBuilder };
  export class CheckBuilder {
    name: string;
    value: SQL;
  }
  export function check(name: string, value: SQL): CheckBuilder;
  export interface PgPolicyConfig {
    using?: SQL;
    withCheck?: SQL;
  }
  export class PgPolicy {
    readonly name: string;
    readonly using: PgPolicyConfig["using"];
    readonly withCheck: PgPolicyConfig["withCheck"];
  }
  export function pgPolicy(name: string, config?: PgPolicyConfig): PgPolicy;
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
  // The pieces sql`...` is made of, which code can also put together itself.
  export class StringChunk {
    readonly value: string[];
    constructor(value: string | readonly string[]);
  }
  // A name, quoted where it's pasted in: sql.identifier() makes one.
  export class Name {
    readonly value: string;
    constructor(value: string);
  }
  export type SQLChunk = StringChunk | SQLChunk[] | Name | SQL;
  export class SQL {
    readonly queryChunks: unknown[];
    constructor(queryChunks: unknown[]);
    as(alias: string): this;
    getSQL(): SQL;
  }
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): SQL;
  export namespace sql {
    function raw(str: string): SQL;
    function identifier(value: string): SQL;
    function fromList(list: unknown[]): SQL;
    function join(chunks: unknown[], separator?: unknown): SQL;
  }
}
