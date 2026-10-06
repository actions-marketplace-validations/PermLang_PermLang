// Prisma: recognizing its client, and the related tables a query reaches.
//
// Each test builds a small project on disk, with stand-ins for the generated client
// laid out the way Prisma 7.10 writes them (verified against `prisma generate`
// output): prisma-client-js into node_modules/.prisma/client or a custom folder, and
// the prisma-client generator's .ts files. The project folder is named prisma-shop,
// and some first-party code lives under src/prisma/, because a path that merely
// mentions Prisma once made PermLang treat Stripe and axios calls as database writes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";

// --- the schema and its generated client --------------------------------------------

interface ModelSpec {
  fields: string[];
  /** relation → [model, list?, foreign key stored in this model?] */
  relations: Record<string, [string, boolean, boolean?]>;
}

const SCHEMA: Record<string, ModelSpec> = {
  Lead: { fields: ["id", "name", "ownerId"], relations: { owner: ["User", false, true], apiKeys: ["ApiKey", true], tags: ["Tag", true] } },
  User: { fields: ["id", "email"], relations: { leads: ["Lead", true], apiKeys: ["ApiKey", true], profile: ["Profile", false] } },
  ApiKey: { fields: ["id", "revoked", "leadId"], relations: { lead: ["Lead", false, true] } },
  Profile: { fields: ["id", "userId"], relations: { user: ["User", false, true] } },
  Tag: { fields: ["id"], relations: { leads: ["Lead", true] } },
};
const MODELS = Object.keys(SCHEMA);
const accessor = (m: string) => m[0]!.toLowerCase() + m.slice(1);

/** One model's types, as either generator writes them (`ns` is how the file refers to the Prisma namespace). */
function modelTypes(name: string, ns: string): string {
  const { fields, relations } = SCHEMA[name]!;
  const rel = Object.entries(relations);
  const objects = rel.map(([r, [m, many]]) => `${r}: ${ns}$${m}Payload<ExtArgs>${many ? "[]" : " | null"}`).join("; ");
  const scalars = fields.map((f) => `${f}: ${f === "name" || f === "email" ? "string" : f === "revoked" ? "boolean" : "number"}`).join("; ");
  const unchecked = [...fields.map((f) => `${f}?: unknown`), ...rel.filter(([, [, , here]]) => !here).map(([r]) => `${r}?: object`)].join("; ");
  const fluent = rel.map(([r, [m, many]]) => `${r}(args?: object): ${many ? "Promise<unknown[]>" : `${ns}Prisma__${m}Client<unknown>`};`).join(" ");
  return `
export type $${name}Payload<ExtArgs = {}> = { name: "${name}"; objects: { ${objects} }; scalars: { ${scalars} }; composites: {} };
export type ${name}UncheckedCreateInput = { ${unchecked} };
export type ${name}CreateInput = { ${[...fields.map((f) => `${f}?: unknown`), ...rel.map(([r]) => `${r}?: object`)].join("; ")} };
export type ${name}WhereInput = { AND?: ${name}WhereInput[]; ${fields.map((f) => `${f}?: unknown`).join("; ")}; ${rel.map(([r]) => `${r}?: object`).join("; ")} };
export type ${name}FindManyArgs = { where?: ${name}WhereInput; include?: object; select?: object; take?: number };
export interface ${name}Delegate<ExtArgs = {}> {
  [K: symbol]: { types: ${ns}TypeMap<ExtArgs>["model"]["${name}"]; meta: { name: "${name}" } };
  findMany(args?: object): Promise<unknown[]>;
  findRaw(args?: object): Promise<unknown>;
  findUnique(args: object): ${ns}Prisma__${name}Client<unknown>;
  count(args?: object): Promise<number>;
  create(args: object): ${ns}Prisma__${name}Client<unknown>;
  update(args: object): ${ns}Prisma__${name}Client<unknown>;
  upsert(args: object): ${ns}Prisma__${name}Client<unknown>;
  delete(args: object): ${ns}Prisma__${name}Client<unknown>;
}
export interface Prisma__${name}Client<T> extends Promise<T> {
  then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1) | null, onrejected?: ((reason: unknown) => R2) | null): Promise<R1 | R2>;
  ${fluent}
}`;
}

function typeMap(ns: string): string {
  const models = MODELS.map((m) => `${m}: { payload: ${ns}$${m}Payload<ExtArgs>; operations: { findMany: { args: object }; findUnique: { args: object }; create: { args: object }; findRaw: { args: object } } }`);
  return `export type TypeMap<ExtArgs = {}> = { meta: { modelProps: ${MODELS.map((m) => `"${accessor(m)}"`).join(" | ")} }; model: { ${models.join("; ")} } };`;
}

function clientMembers(ns: string): string {
  return [
    "$queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;",
    `$extends(extension: object): runtime.DynamicClientExtensionThis<${ns}TypeMap<ExtArgs>, ExtArgs>;`,
    ...MODELS.map((m) => `get ${accessor(m)}(): ${ns}${m}Delegate<ExtArgs>;`),
  ].join("\n  ");
}

/** @prisma/client/runtime/client.d.ts: the types `$extends` clients are built from (names as in Prisma's runtime). */
const RUNTIME = `
export type TypeMapDef = { meta: { modelProps: string }; model: Record<string, { payload: { name: string; objects: Record<string, unknown> }; operations: Record<string, { args: unknown }> }> };
type ModelKey<TypeMap extends TypeMapDef, M extends PropertyKey> = M extends keyof TypeMap["model"] ? M : Capitalize<M & string>;
type NameOf<T> = T extends { name: infer N } ? N & PropertyKey : never;
export type DynamicClientExtensionThis<TypeMap extends TypeMapDef, ExtArgs> = {
  [P in TypeMap["meta"]["modelProps"]]: DynamicModelExtensionThis<TypeMap, ModelKey<TypeMap, P>, ExtArgs>;
} & { $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown> };
export type DynamicModelExtensionThis<TypeMap extends TypeMapDef, M extends PropertyKey, ExtArgs> = {
  [P in keyof TypeMap["model"][M & string]["operations"]]: DynamicModelExtensionOperationFn<TypeMap, M, P>;
};
export interface PrismaPromise<T> extends Promise<T> {
  then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1) | null, onrejected?: ((reason: unknown) => R2) | null): Promise<R1 | R2>;
}
export type DynamicModelExtensionOperationFn<TypeMap extends TypeMapDef, M extends PropertyKey, P extends PropertyKey> =
  (args?: object) => DynamicModelExtensionFluentApi<TypeMap, M, P, null> & PrismaPromise<unknown>;
export type DynamicModelExtensionFluentApi<TypeMap extends TypeMapDef, M extends PropertyKey, P extends PropertyKey, Null> = {
  [K in keyof TypeMap["model"][M & string]["payload"]["objects"]]: (args?: object) =>
    PrismaPromise<unknown> & DynamicModelExtensionFluentApi<TypeMap, NameOf<TypeMap["model"][M & string]["payload"]["objects"][K]>, P, Null>;
};
// Builds a Sql value for $queryRaw; it runs nothing itself.
export declare function sqltag(strings: TemplateStringsArray, ...values: unknown[]): unknown;`;

/** prisma-client-js: one declaration file, the models in `namespace Prisma`. */
function jsClient(runtimeImport: string): string {
  return `
/**
 * Client
**/

import * as runtime from '${runtimeImport}';

export class PrismaClient<ExtArgs = {}> {
  constructor(options?: object);
  ${clientMembers("Prisma.")}
}

export namespace Prisma {
${MODELS.map((m) => modelTypes(m, "Prisma.")).join("\n")}
${typeMap("Prisma.")}
export type Subset<T, U> = { [key in keyof T]: key extends keyof U ? T[key] : never };
export const sql: typeof runtime.sqltag;
export type SelectSubset<T, U> = { [key in keyof T]: key extends keyof U ? T[key] : never } & (T extends { select: unknown; include: unknown } ? "Please either choose \`select\` or \`include\`." : {});
}`;
}

const HEADER = "/* !!! This is code generated by Prisma. Do not edit directly. !!! */\n/* eslint-disable */\n// biome-ignore-all lint: generated file\n// @ts-nocheck \n";

/** The prisma-client generator: .ts files in the project, one per model. */
function modernClient(dir: string): Record<string, string> {
  const files: Record<string, string> = {
    [`${dir}/internal/prismaNamespace.ts`]: `${HEADER}import type * as runtime from "@prisma/client/runtime/client"\n${MODELS.map((m) => `export type * from "../models/${m}.ts"`).join("\n")}\nexport ${typeMap("").replace(/^export /, "")}`,
    [`${dir}/internal/class.ts`]: `${HEADER}import * as runtime from "@prisma/client/runtime/client"\nimport type * as Prisma from "./prismaNamespace.ts"\ntype ExtArgs = {};\nexport interface PrismaClient {\n  ${clientMembers("Prisma.")}\n}`,
    [`${dir}/client.ts`]: `${HEADER}import * as $Class from "./internal/class.ts"\nexport type * as Prisma from "./internal/prismaNamespace.ts"\nexport declare const PrismaClient: new (options?: object) => $Class.PrismaClient;\nexport type PrismaClient = $Class.PrismaClient;`,
  };
  for (const m of MODELS) {
    files[`${dir}/models/${m}.ts`] = `${HEADER}import type * as runtime from "@prisma/client/runtime/client"\nimport type * as Prisma from "../internal/prismaNamespace.ts"\n${modelTypes(m, "Prisma.")}`;
  }
  return files;
}

// Libraries whose files are under prisma-shop/node_modules, so their paths contain "prisma".
const STRIPE = `
declare class RefundResource { create(params?: object): Promise<unknown>; }
declare class CustomerResource { retrieve(id: string): Promise<unknown>; }
declare class Stripe { constructor(key: string, config?: object); refunds: RefundResource; customers: CustomerResource; }
export default Stripe;`;
const AXIOS = `
export class Axios { get(url: string): Promise<unknown>; delete(url: string): Promise<unknown>; }
export interface AxiosStatic extends Axios { (url: string): Promise<unknown>; }
declare const axios: AxiosStatic;
export default axios;`;

const pkg = (name: string) => JSON.stringify({ name, types: "index.d.ts" });

// --- the project --------------------------------------------------------------------

let root: string;
let report: Report;

const APP = {
  // Third-party libraries in a folder whose name contains "prisma".
  "src/shop.ts": `
import Stripe from "stripe";
import axios from "axios";
const stripe = new Stripe("sk_test_placeholder");
/** @perm env(NONE) */
export function refund() { return stripe.refunds.create({ charge: "ch_1" }); } // expect payments.refund, net(api.stripe.com)
/** @perm env(NONE) */
export function remove() { return axios.delete("https://evil.example/x"); } // expect net(evil.example)
`,
  // First-party code under src/prisma/: a repository whose methods share Prisma's names.
  "src/prisma/repo.ts": `
export interface LeadDelegate { findMany(): Promise<unknown[]>; }
export class LeadRepo implements LeadDelegate {
  findMany() { return fetch("https://api.example/leads").then(() => []); }
  create(name: string) { return name; }
}
`,
  "src/prisma/use.ts": `
import { LeadRepo, type LeadDelegate } from "./repo.js";
const repo = new LeadRepo();
/** @perm env(NONE) */
export function viaClass() { return repo.findMany(); }
/** @perm env(NONE) */
export function viaInterface(leads: LeadDelegate) { return leads.findMany(); }
/** @perm env(NONE) */
export function plain() { return repo.create("x"); }
`,
  // The project's own code using Prisma's runtime the way generated files do, but with bodies.
  "src/prisma/cache.ts": `
import * as runtime from "@prisma/client/runtime/client.js";
export type Map = runtime.TypeMapDef;
export class Cache { findMany() { return fetch("https://cache.example/all"); } }
/** @perm env(NONE) */
export function warm() { return new Cache().findMany(); }
`,
  // The client in node_modules, as `prisma generate` writes it by default.
  "src/default-client.ts": `
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();
const ext = prisma.$extends({});
/** @perm env(NONE) */ export function read() { return prisma.lead.findMany(); }
/** @perm env(NONE) */ export function raw() { return prisma.$queryRaw\`SELECT 1\`; }
/** @perm env(NONE) */ export function include() { return prisma.lead.findMany({ include: { apiKeys: true, owner: { include: { profile: true } } } }); }
/** @perm env(NONE) */ export function select() { return prisma.lead.findUnique({ where: { id: 1 }, select: { name: true, owner: { select: { email: true } } } }); }
/** @perm env(NONE) */ export function scalars(id: number) { return prisma.lead.findMany({ where: { id, name: { contains: "x" } }, select: { id: true }, orderBy: { name: "asc" } }); }
/** @perm env(NONE) */ export function filter() { return prisma.lead.count({ where: { owner: { apiKeys: { some: { revoked: false } } } } }); }
/** @perm env(NONE) */ export function logical() { return prisma.lead.count({ where: { OR: [{ tags: { none: {} } }, { owner: { is: { email: "a" } } }] } }); }
/** @perm env(NONE) */ export function order() { return prisma.lead.findMany({ orderBy: [{ owner: { email: "asc" } }, { apiKeys: { _count: "desc" } }] }); }
/** @perm env(NONE) */ export function countSome() { return prisma.user.findMany({ select: { _count: { select: { leads: true } } } }); }
/** @perm env(NONE) */ export function countAll() { return prisma.user.findMany({ include: { _count: true } }); }
/** @perm env(NONE) */ export function nested() { return prisma.lead.update({ where: { id: 1 }, data: { apiKeys: { deleteMany: {} }, owner: { update: { email: "x" } } } }); }
/** @perm env(NONE) */ export function upsert() { return prisma.user.upsert({ where: { id: 1 }, create: { email: "a", apiKeys: { create: { revoked: false } } }, update: { leads: { updateMany: { where: { name: "x" }, data: { name: "y" } } } } }); }
/** @perm env(NONE) */ export function connectHere(id: number) { return prisma.lead.create({ data: { name: "x", owner: { connect: { id } } } }); }
/** @perm env(NONE) */ export function connectThere(id: number) { return prisma.user.update({ where: { id: 1 }, data: { profile: { connect: { id } } } }); }
/** @perm env(NONE) */ export function connectList(id: number) { return prisma.lead.update({ where: { id: 1 }, data: { tags: { connect: [{ id }] } } }); }
/** @perm env(NONE) */ export function disconnect() { return prisma.apiKey.update({ where: { id: 1 }, data: { lead: { disconnect: true } } }); }
/** @perm env(NONE) */ export function typedWhere(where: Prisma.LeadWhereInput) { return prisma.lead.findMany({ where }); }
/** @perm env(NONE) */ export function typedData(data: Prisma.LeadCreateInput) { return prisma.lead.create({ data }); }
/** @perm env(NONE) */ export function narrowData(data: { name: string; ownerId: number }) { return prisma.lead.create({ data }); }
/** @perm env(NONE) */ export function anyData(body: any) { return prisma.lead.create({ data: body }); }
/** @perm env(NONE) */ export function spread(args: Prisma.LeadFindManyArgs) { return prisma.lead.findMany({ ...args, take: 5 }); }
/** @perm env(NONE) */ export function computed(key: string) { return prisma.lead.findMany({ include: { [key]: true } }); }
/** @perm env(NONE) */ export function generic<T extends Prisma.LeadFindManyArgs>(args: T) { return prisma.lead.findMany(args); }
/** @perm env(NONE) */ export function subset<T extends Prisma.LeadFindManyArgs>(args: Prisma.SelectSubset<T, Prisma.LeadFindManyArgs>) { return prisma.lead.findMany(args); }
/** @perm env(NONE) */ export function counted<T extends Prisma.LeadFindManyArgs>(args: Prisma.Subset<T, Prisma.LeadFindManyArgs>) { return prisma.lead.count(args); }
/** @perm env(NONE) */ export function picked(where: Pick<Prisma.LeadWhereInput, "id" | "name">) { return prisma.lead.findMany({ where }); }
/** @perm env(NONE) */ export function fluent() { return prisma.user.findUnique({ where: { id: 1 } }).leads(); }
/** @perm env(NONE) */ export function extended() { return ext.user.findMany({ include: { leads: true } }); }
/** @perm env(NONE) */ export function extendedFluent() { return ext.lead.findUnique({ where: { id: 1 } }).owner().apiKeys(); }
/** @perm env(NONE) */ export function fluentThen() { return prisma.user.findUnique({ where: { id: 1 } }).then((u) => u); }
/** @perm env(NONE) */ export function fluentArgs() { return prisma.user.findUnique({ where: { id: 1 } }).leads({ where: { apiKeys: { some: {} } } }); }
/** @perm env(NONE) */ export function nestedInput(owner: { connect?: { id: number }; create?: Prisma.UserCreateInput }) { return prisma.lead.create({ data: { name: "x", owner } }); }
/** @perm env(NONE) */ export function paging(page: { take: number }) { return prisma.lead.findMany({ ...page, where: { id: 1 } }); }
/** @perm env(NONE) */ export function orFilters(filters: Prisma.LeadWhereInput[]) { return prisma.lead.findMany({ where: { OR: [...filters] } }); }
/** @perm env(NONE) */ export function quoted() { return prisma.lead.findMany({ include: { "owner": true } }); }
/** @perm env(NONE) */ export function otherMethod() { return prisma.lead.findRaw(); }
/** @perm env(NONE) */ export function sqlHelper() { return Prisma.sql\`SELECT 1\`; }
/** @perm env(NONE) */ export function asValue() { return [{}].map(prisma.lead.findMany); }
/** @perm env(NONE) */ export function extendedOther() { return ext.lead.findRaw(); }
/** @perm env(NONE) */ export function extendedThen() { return ext.lead.findUnique({ where: { id: 1 } }).then((x) => x); }
/** @perm env(NONE) */ export function extendedAfterList() { return ext.user.findUnique({ where: { id: 1 } }).leads().then((x) => x); }
/** @perm env(NONE) */ export function deep() { return prisma.lead.findMany(${"{ include: { owner: { include: { leads: ".repeat(20)}true${" } } } }".repeat(20)}); }
`,
  // prisma-client-js with a custom output folder, which copies the runtime next to it.
  "src/custom-client.ts": `
import { PrismaClient } from "./db/client/index.js";
const prisma = new PrismaClient();
const ext = prisma.$extends({});
/** @perm env(NONE) */ export function read() { return prisma.lead.findMany({ include: { tags: true } }); }
/** @perm env(NONE) */ export function extended() { return [ext.user.findMany({ include: { profile: true } }), ext.$queryRaw\`SELECT 1\`]; }
`,
  // The prisma-client generator, which writes .ts files among the project's own.
  "src/modern-client.ts": `
import { PrismaClient } from "./generated/db/client.ts";
const prisma = new PrismaClient();
/** @perm env(NONE) */ export function read() { return prisma.lead.findMany({ include: { owner: true } }); }
/** @perm env(NONE) */ export function write(id: number) { return prisma.user.update({ where: { id: 1 }, data: { profile: { connect: { id } } } }); }
`,
  // Prisma's header alone marks a generated file, whatever it imports.
  "src/generated/headed.ts": `${HEADER}export interface AuditDelegate { findMany(args?: object): Promise<unknown[]>; }\nexport declare const audit: AuditDelegate;
export type $AuditPayload = { name: "Audit"; objects: { owner: { name: string }; other: {} } };
export interface BareDelegate { findMany(args?: object): Promise<unknown[]>; }
export declare const bare: BareDelegate;
export type $BarePayload = { name: "Bare" };`,
  "src/headed.ts": `
import { audit, bare } from "./generated/headed.ts";
/** @perm env(NONE) */ export function read() { return audit.findMany(); }
// Payloads Prisma wouldn't write: what can't be read about a relation is unknown.
/** @perm env(NONE) */ export function oddRelations() { return audit.findMany({ include: { owner: true, other: true } }); }
/** @perm env(NONE) */ export function noRelations() { return bare.findMany({ include: { x: true }, where: { tags: { some: {} } } }); }
/** @perm env(NONE) */ export function noRelationsCounted() { return bare.findMany({ select: { _count: true } }); }
/** @perm env(NONE) */ export function noRelationsPlain(id: number) { return bare.findMany({ where: { id }, select: { y: false } }); }
/** @perm env(NONE) */ export function noRelationsList() { return bare.findMany({ where: { ids: [1] } }); }
/** @perm env(NONE) */ export function noRelationsTyped(args: { where: { id: number } }) { return bare.findMany(args); }
`,
  // A hand-written look-alike with no generator markers is the project's own code.
  "src/lookalike/client.d.ts": `export interface LeadDelegate { findMany(args?: object): Promise<unknown[]>; } export declare const prisma: { lead: LeadDelegate };`,
  "src/lookalike.ts": `
import { prisma } from "./lookalike/client.js";
/** @perm env(NONE) */ export function read() { return prisma.lead.findMany(); }
`,
  // A file that claims to be generated by Prisma: only Prisma's own API in it is trusted.
  "src/spoof/client.d.ts": `/* !!! This is code generated by Prisma. Do not edit directly. !!! */
export declare class PrismaClient {
  constructor(options?: object);
  $connect(): Promise<void>;
  evil(): void;
}
export declare function run(): void;
`,
  "src/spoof.ts": `
import { PrismaClient, run } from "./spoof/client.js";
/** @perm env(NONE) */ export function viaApi() { return new PrismaClient().$connect(); }
/** @perm env(NONE) */ export function viaMember() { return new PrismaClient().evil(); }
/** @perm env(NONE) */ export function viaFunction() { return run(); }
`,
};

beforeAll(() => {
  root = path.join(mkdtempSync(path.join(tmpdir(), "permlang-prisma-")), "prisma-shop");
  const files: Record<string, string> = {
    ...APP,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, lib: ["ES2022", "DOM"], types: [] },
      include: ["src/**/*.ts"],
    }),
    "node_modules/stripe/package.json": pkg("stripe"),
    "node_modules/stripe/index.d.ts": STRIPE,
    "node_modules/axios/package.json": pkg("axios"),
    "node_modules/axios/index.d.ts": AXIOS,
    "node_modules/@prisma/client/package.json": pkg("@prisma/client"),
    "node_modules/@prisma/client/index.d.ts": "export * from '.prisma/client/default'",
    "node_modules/@prisma/client/runtime/client.d.ts": RUNTIME,
    "node_modules/.prisma/client/default.d.ts": "export * from './index'",
    "node_modules/.prisma/client/index.d.ts": jsClient("@prisma/client/runtime/client.js"),
    "src/db/client/index.d.ts": jsClient("./runtime/client.js"),
    "src/db/client/runtime/client.d.ts": RUNTIME,
    ...modernClient("src/generated/db"),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  report = checkTsConfig(path.join(root, "tsconfig.json"));
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true, maxRetries: 5 });
});

/** What a function reaches, sorted. */
function actual(file: string, name: string): string[] {
  const fn = report.functions.find((f) => path.resolve(f.file) === path.join(root, file) && f.name === name);
  expect(fn, `${file}:${name}`).toBeDefined();
  return [...fn!.actual].sort();
}

describe("recognizing Prisma", () => {
  it("doesn't mistake libraries in a folder named like Prisma for it", () => {
    expect(actual("src/shop.ts", "refund")).toEqual(["net(api.stripe.com)", "payments.refund"]);
    expect(actual("src/shop.ts", "remove")).toEqual(["net(evil.example)"]);
  });

  it("doesn't mistake the project's own code under src/prisma/ for it", () => {
    expect(actual("src/prisma/use.ts", "viaClass")).toEqual(["net(api.example)"]);
    expect(actual("src/prisma/use.ts", "viaInterface")).toEqual(["net(api.example)"]);
    expect(actual("src/prisma/use.ts", "plain")).toEqual([]);
    expect(actual("src/prisma/cache.ts", "warm")).toEqual(["net(cache.example)"]);
  });

  it("doesn't take a hand-written look-alike for a generated client", () => {
    // Not read as Prisma; its JavaScript, which nothing here shows, is unverifiable.
    const reach = actual("src/lookalike.ts", "read");
    expect(reach.filter((c) => c.startsWith("db."))).toEqual([]);
    expect(reach).toContain("unverifiable");
  });

  it("trusts only Prisma's own API in a file that claims to be generated", () => {
    expect(actual("src/spoof.ts", "viaApi")).toEqual([]);
    expect(actual("src/spoof.ts", "viaMember")).toContain("unverifiable");
    expect(actual("src/spoof.ts", "viaFunction")).toContain("unverifiable");
  });

  it("finds the client in node_modules, in a custom output folder, and from the prisma-client generator", () => {
    expect(actual("src/default-client.ts", "read")).toEqual(["db.read(lead)"]);
    expect(actual("src/default-client.ts", "raw")).toEqual(["db.read", "db.write"]);
    expect(actual("src/custom-client.ts", "read")).toEqual(["db.read(lead)", "db.read(tag)"]);
    // Its `$extends` client is typed by the runtime copied next to it.
    expect(actual("src/custom-client.ts", "extended")).toEqual(["db.read", "db.read(profile)", "db.read(user)", "db.write"]);
    expect(actual("src/modern-client.ts", "read")).toEqual(["db.read(lead)", "db.read(user)"]);
    // These delegates have one method, so a call through them also reaches any project class
    // with a findMany (src/prisma/use.ts's): the engine charges every class that fits an
    // interface. A real client's delegates have a dozen methods, which no project class fits.
    const db = (name: string) => actual("src/headed.ts", name).filter((c) => c.startsWith("db."));
    expect(db("read")).toEqual(["db.read(audit)"]);
    expect(db("oddRelations")).toEqual(["db.read", "db.read(audit)"]);
    expect(db("noRelations")).toEqual(["db.read", "db.read(bare)"]);
    expect(db("noRelationsCounted")).toEqual(["db.read", "db.read(bare)"]);
    expect(db("noRelationsPlain")).toEqual(["db.read(bare)"]);
    expect(db("noRelationsList")).toEqual(["db.read", "db.read(bare)"]);
    expect(db("noRelationsTyped")).toEqual(["db.read", "db.read(bare)"]);
  });
});

describe("related tables", () => {
  const cases: [string, string[]][] = [
    ["include", ["db.read(apiKey)", "db.read(lead)", "db.read(profile)", "db.read(user)"]],
    ["select", ["db.read(lead)", "db.read(user)"]],
    ["scalars", ["db.read(lead)"]],
    ["filter", ["db.read(apiKey)", "db.read(lead)", "db.read(user)"]],
    ["logical", ["db.read(lead)", "db.read(tag)", "db.read(user)"]],
    ["order", ["db.read(apiKey)", "db.read(lead)", "db.read(user)"]],
    ["countSome", ["db.read(lead)", "db.read(user)"]],
    ["countAll", ["db.read(apiKey)", "db.read(lead)", "db.read(profile)", "db.read(user)"]],
    ["nested", ["db.write(apiKey)", "db.write(lead)", "db.write(user)"]],
    ["upsert", ["db.write(apiKey)", "db.write(lead)", "db.write(user)"]],
    // A foreign key kept in this model: linking reads the related record, and writes this one.
    ["connectHere", ["db.read(user)", "db.write(lead)"]],
    // Kept in the related model, or in a link table for a list: linking writes it.
    ["connectThere", ["db.write(profile)", "db.write(user)"]],
    ["connectList", ["db.write(lead)", "db.write(tag)"]],
    ["disconnect", ["db.write(apiKey)"]],
    // Not written out: a type that can name a relation could reach any table.
    ["typedWhere", ["db.read", "db.read(lead)"]],
    ["typedData", ["db.read", "db.write", "db.write(lead)"]],
    ["narrowData", ["db.write(lead)"]],
    ["anyData", ["db.read", "db.write", "db.write(lead)"]],
    ["spread", ["db.read", "db.read(lead)"]],
    ["computed", ["db.read", "db.read(lead)"]],
    // A generic type counts by its constraint, or as unknown when its keys aren't known yet.
    ["generic", ["db.read", "db.read(lead)"]],
    ["subset", ["db.read", "db.read(lead)"]],
    ["counted", ["db.read", "db.read(lead)"]],
    ["picked", ["db.read(lead)"]],
    ["fluent", ["db.read(lead)", "db.read(user)"]],
    ["extended", ["db.read(lead)", "db.read(user)"]],
    ["extendedFluent", ["db.read(apiKey)", "db.read(lead)", "db.read(user)"]],
    // Deeper than any real query: the walk stops, and what's below could be anything.
    ["deep", ["db.read", "db.read(lead)", "db.read(user)"]],
    ["fluentThen", ["db.read(user)"]],
    ["fluentArgs", ["db.read(apiKey)", "db.read(lead)", "db.read(user)"]],
    ["nestedInput", ["db.read", "db.write", "db.write(lead)", "db.write(user)"]],
    ["paging", ["db.read(lead)"]],
    ["orFilters", ["db.read", "db.read(lead)"]],
    ["quoted", ["db.read(lead)", "db.read(user)"]],
    // Other methods on a model (findRaw, aggregateRaw) may read or write.
    ["otherMethod", ["db.read(lead)", "db.write(lead)"]],
    ["sqlHelper", []],
    ["asValue", ["db.read(lead)"]],
    ["extendedOther", ["db.read(lead)", "db.write(lead)"]],
    ["extendedThen", ["db.read(lead)"]],
    ["extendedAfterList", ["db.read(lead)", "db.read(user)"]],
  ];
  it.each(cases)("%s", (name, expected) => {
    expect(actual("src/default-client.ts", name)).toEqual(expected);
  });

  it("works the same with the prisma-client generator's files", () => {
    expect(actual("src/modern-client.ts", "write")).toEqual(["db.write(profile)", "db.write(user)"]);
  });
});
