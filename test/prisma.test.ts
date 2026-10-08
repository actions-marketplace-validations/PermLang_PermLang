// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Prisma: recognizing its client, and the related tables a query reaches.
//
// Each test builds a small project on disk, with stand-ins for the generated client
// laid out the way Prisma 7.10 writes them (verified against `prisma generate`
// output): prisma-client-js into node_modules/.prisma/client or a custom folder, and
// the prisma-client generator's .ts files. The project folder is named prisma-shop,
// and some first-party code lives under src/prisma/, because a path that merely
// mentions Prisma once made PermLang treat Stripe and axios calls as database writes.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { prismaCapabilities } from "../src/detect/prisma.js";
import { removeTemporary } from "./temporary.js";

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
export type ${name}UpdateArgs = { where: object; data: object };
export type ${name}CreateArgs = { data: object };
export type ${name}FindUniqueArgs = { where: object };
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
  const operations = (m: string) =>
    `findMany: { args: ${ns}${m}FindManyArgs }; findUnique: { args: ${ns}${m}FindUniqueArgs }; create: { args: ${ns}${m}CreateArgs }; update: { args: ${ns}${m}UpdateArgs }; findRaw: { args: object }; count: { args: object }`;
  const models = MODELS.map((m) => `${m}: { payload: ${ns}$${m}Payload<ExtArgs>; operations: { ${operations(m)} } }`);
  return `export type TypeMap<ExtArgs = {}> = { meta: { modelProps: ${MODELS.map((m) => `"${accessor(m)}"`).join(" | ")} }; model: { ${models.join("; ")} } };
// $use middleware, as clients before Prisma 6 declare it: \`next\` runs the operation.
export type MiddlewareParams = { model?: string; action: string; args: any; dataPath: string[]; runInTransaction: boolean };
export type Middleware<T = any> = (params: MiddlewareParams, next: (params: MiddlewareParams) => Promise<T>) => Promise<T>;`;
}

function clientMembers(ns: string): string {
  const props = `${ns}TypeMap["meta"]["modelProps"] | "$allModels" | "$allOperations"`;
  return [
    "$queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;",
    `$use(cb: ${ns}Middleware): void;`,
    `$extends<Q_ extends { [K in ${props}]?: unknown }>(extension: { query?: runtime.DynamicQueryExtensionArgs<Q_, ${ns}TypeMap<ExtArgs>> }): runtime.DynamicClientExtensionThis<${ns}TypeMap<ExtArgs>, ExtArgs>;`,
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
// Like Prisma's, the operations are mapped over keys left after the extension's own, so
// they have no declarations of their own.
export type DynamicModelExtensionThis<TypeMap extends TypeMapDef, M extends PropertyKey, ExtArgs> = {
  [P in Exclude<keyof TypeMap["model"][M & string]["operations"], keyof ExtArgs>]: DynamicModelExtensionOperationFn<TypeMap, M, P>;
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
// Query extensions: each callback gets the operation's arguments and a \`query\` function that runs it.
type Operations<TypeMap extends TypeMapDef, M> = M extends keyof TypeMap["model"] ? keyof TypeMap["model"][M]["operations"] : never;
type OperationArgs<TypeMap extends TypeMapDef, M, P> = M extends keyof TypeMap["model"] ? P extends keyof TypeMap["model"][M]["operations"] ? TypeMap["model"][M]["operations"][P]["args"] : never : never;
export type DynamicQueryExtensionArgs<Q_, TypeMap extends TypeMapDef> = {
  [K in keyof Q_]: K extends "$allOperations"
    ? (args: { model?: string; operation: string; args: any; query: (args: any) => PrismaPromise<any> }) => Promise<any>
    : K extends "$allModels"
      ? { [P in keyof Q_[K] | Operations<TypeMap, keyof TypeMap["model"]> | "$allOperations"]?: P extends "$allOperations" ? DynamicQueryExtensionCb<TypeMap, "model", keyof TypeMap["model"], Operations<TypeMap, keyof TypeMap["model"]>> : DynamicQueryExtensionCb<TypeMap, "model", keyof TypeMap["model"], P> }
      : K extends TypeMap["meta"]["modelProps"]
        ? { [P in keyof Q_[K] | Operations<TypeMap, ModelKey<TypeMap, K>> | "$allOperations"]?: P extends "$allOperations" ? DynamicQueryExtensionCb<TypeMap, "model", ModelKey<TypeMap, K>, Operations<TypeMap, ModelKey<TypeMap, K>>> : DynamicQueryExtensionCb<TypeMap, "model", ModelKey<TypeMap, K>, P> }
        : never;
};
export type DynamicQueryExtensionCb<TypeMap extends TypeMapDef, _0 extends PropertyKey, _1 extends PropertyKey, _2 extends PropertyKey> =
  <A extends DynamicQueryExtensionCbArgs<TypeMap, _0, _1, _2>>(args: A) => Promise<unknown>;
export type DynamicQueryExtensionCbArgs<TypeMap extends TypeMapDef, _0 extends PropertyKey, _1 extends PropertyKey, _2 extends PropertyKey> = (_1 extends unknown ? _2 extends unknown ? {
  args: OperationArgs<TypeMap, _1, _2>;
  model: _0 extends 0 ? undefined : _1;
  operation: _2;
  query: <A extends OperationArgs<TypeMap, _1, _2>>(args: A) => PrismaPromise<unknown>;
} : never : never) & {
  query: (args: OperationArgs<TypeMap, _1, _2>) => PrismaPromise<unknown>;
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
// Called through .call, .apply, or .bind, or passed along as a value: the arguments can't be read.
/** @perm env(NONE) */ export function viaCall() { return prisma.lead.update.call(prisma.lead, { where: { id: 1 }, data: { apiKeys: { deleteMany: {} } } }); }
/** @perm env(NONE) */ export function viaApply() { return prisma.lead.update.apply(prisma.lead, [{ where: { id: 1 }, data: { apiKeys: { deleteMany: {} } } }]); }
/** @perm env(NONE) */ export function viaBind(rows: object[]) { const create = prisma.lead.create.bind(prisma.lead); return rows.map(create); }
/** @perm env(NONE) */ export function fluentValue() { const user = prisma.user.findUnique({ where: { id: 1 } }); return [{}].map(user.leads); }
/** @perm env(NONE) */ export function extendedValue() { return [{}].map(ext.lead.findMany); }
/** @perm env(NONE) */ export function extendedCall() { return ext.lead.create.call(ext.lead, {}); }
/** @perm env(NONE) */ export function extendedAlias() { const find = ext.lead.findMany; return find({ include: { owner: true } }); }
/** @perm env(NONE) */ export function extendedFluentValue() { const lead = ext.lead.findUnique({ where: { id: 1 } }); return [{}].map(lead.owner); }
/** @perm env(NONE) */ export function extendedFluentAlias() { const owner = ext.lead.findUnique({ where: { id: 1 } }).owner; return owner(); }
// A member read straight off a cast is looked up on the client's own type.
/** @perm env(NONE) */ export function castClient() { return (prisma as any).lead.delete({ where: { owner: { email: "x" } } }); }
/** @perm env(NONE) */ export function castModel() { return (prisma.apiKey as any).delete({ where: { id: 1 } }); }
/** @perm env(NONE) */ export function castThroughUnknown() { return (prisma as unknown as { user: { create(a: object): unknown } }).user.create({ data: {} }); }
// Stored or passed on as \`any\`, a client isn't followed, like a global object.
/** @perm env(NONE) */ export function castStored(register: (value: any) => void) { const p: any = prisma; register(p); return p.lead.delete({}); }
// A model chosen at run time could be any model, whatever is called on it.
/** @perm env(NONE) */ export function modelByName(model: string) { return (prisma as any)[model].delete({}); }
/** @perm env(NONE) */ export function modelByUnion(model: "lead" | "user") { return prisma[model].findMany(); }
/** @perm env(NONE) */ export function modelByRecord(model: string) { return (prisma as unknown as Record<string, { delete(a: object): unknown }>)[model]!.delete({}); }
/** @perm env(NONE) */ export function extendedByName(model: "lead" | "user") { return ext[model].findMany(); }
/** @perm env(NONE) */ export function modelByLiteral(model: "lead") { return [prisma["lead"].findMany(), prisma[model].findMany()]; }
/** @perm env(NONE) */ export function otherComputed(filters: Record<string, string>, key: string) { return [filters[key], prisma.lead.findMany()]; }
`,
  // Query extensions: a callback's \`query\` runs the operation it intercepts, with the arguments it's given.
  "src/extensions.ts": `
import { PrismaClient } from "@prisma/client";
const base = new PrismaClient();
export const xprisma = base.$extends({
  query: {
    lead: {
      findMany({ args, query }) { return query({ ...args, include: { apiKeys: true } }); },
      update(params) { return params.query({ where: { id: 1 }, data: { tags: { deleteMany: {} } } }); },
      $allOperations({ args, query }) { return query(args); },
    },
    user: {
      create({ query: run }) { return run({ data: { email: "x", leads: { create: { name: "y" } } } }); },
      findUnique({ args, query }) { return run(query, args); },
    },
    $allModels: {
      findRaw({ args, query }) { return query(args); },
    },
  },
});
/** @perm db.read(lead) */ export function listLeads() { return xprisma.lead.findMany(); }
// A helper with a type of its own: what it calls isn't Prisma's to it.
function run(f: (args: unknown) => Promise<unknown>, args: unknown) { return f(args); }
`,
  "src/middleware.ts": `
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();
/** @perm env(NONE) */ export function install() { prisma.$use(async (params, next) => next({ ...params, args: { include: { apiKeys: true } } })); }
const logging: Prisma.Middleware = async (params, next) => next(params);
/** @perm env(NONE) */ export function installTyped() { prisma.$use(logging); }
/** @perm env(NONE) */ export function typedParameter(mw: Prisma.Middleware) { return [mw]; }
// \`next\` handed to a function of the project's, whose own type says nothing of Prisma.
/** @perm env(NONE) */ export function installForwarding() { prisma.$use(async (params, next) => forward(next, params)); }
function forward(run: (params: Prisma.MiddlewareParams) => Promise<unknown>, params: Prisma.MiddlewareParams) { return run(params); }
export function installByCall(mw: Prisma.Middleware) { prisma.$use.call(prisma, mw); }
`,
  "src/extensions-all.ts": `
import { PrismaClient } from "@prisma/client";
export const all = new PrismaClient().$extends({ query: { $allOperations({ args, query }) { return query(args); } } });
`,
  // More ways of getting at \`query\` in a query extension's callback.
  "src/extensions-more.ts": `
import { PrismaClient } from "@prisma/client";
export const more = new PrismaClient().$extends({
  query: {
    lead: {
      // An operation whose arguments' type isn't one of the client's aliases: its relations can't be found.
      count({ query }) { return query({ where: { owner: { email: "x" } } }); },
      // Destructured from the parameter in the body.
      findMany(params) { const { args, query } = params; return query({ ...args, include: { tags: true } }); },
      // Held under another name: what it runs can't be read.
      update({ args, query }) { const ops = { run: query }; return ops.run(args); },
      create({ args, query }) { return (args ? query : query)(args); },
      findUnique({ args, query }) { const { run } = { run: query }; return run(args); },
    },
  },
});
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
export interface BareDelegate { findMany(args?: object): Promise<unknown[]>; findUnique(args: object): Prisma__BareClient<unknown>; }
export interface Prisma__BareClient<T> extends Promise<T> {
  then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1) | null, onrejected?: ((reason: unknown) => R2) | null): Promise<R1 | R2>;
  owner(args?: object): Promise<unknown>;
}
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
// Without relations, any fluent method but a promise's could follow one, to any table.
/** @perm env(NONE) */ export function noRelationsFluent() { return bare.findUnique({ where: { id: 1 } }).owner(); }
/** @perm env(NONE) */ export function noRelationsThen() { return bare.findUnique({ where: { id: 1 } }).then((x) => x); }
`,
  // A hand-written look-alike with no generator markers is the project's own code.
  "src/lookalike/client.d.ts": `export interface LeadDelegate { findMany(args?: object): Promise<unknown[]>; } export declare const prisma: { lead: LeadDelegate };`,
  "src/lookalike.ts": `
import { prisma } from "./lookalike/client.js";
/** @perm env(NONE) */ export function read() { return prisma.lead.findMany(); }
`,
  // A file that claims to be generated by Prisma, among the project's own: nothing in it is trusted,
  // since the JavaScript behind it could do anything. (Prisma's real output has its own package.json.)
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
  // The same claim in a folder with its own package.json: a package, which prisma-client-js's
  // output only is when it imports Prisma's runtime. (Its .d.ts files carry no header.)
  "src/forged/package.json": JSON.stringify({ name: "prisma-client-forged", main: "index.js", types: "index.d.ts" }),
  "src/forged/index.d.ts": `/* !!! This is code generated by Prisma. Do not edit directly. !!! */
export declare class PrismaClient { constructor(options?: object); $run(command: string): unknown; }
`,
  "src/forged.ts": `
import { PrismaClient } from "./forged/index.js";
/** @perm env(NONE) */ export function viaForged(command: string) { return new PrismaClient().$run(command); }
`,
  // Another file of the generated client's folder, which doesn't import the runtime itself (as TypedSQL's don't).
  "src/typed-sql.ts": `
import { PrismaClient } from "./db/client/index.js";
import { recentLeads } from "./db/client/sql/index.js";
/** @perm env(NONE) */ export function typed() { return [new PrismaClient(), recentLeads()]; }
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
    // prisma-client-js writes a package.json into its output folder, which makes it a package.
    "src/db/client/package.json": JSON.stringify({ name: "prisma-client-0123abcd", main: "index.js", types: "index.d.ts" }),
    "src/db/client/index.d.ts": jsClient("./runtime/client.js"),
    "src/db/client/runtime/client.d.ts": RUNTIME,
    "src/db/client/sql/index.d.ts": "export declare function recentLeads(): { sql: string };\n",
    ...modernClient("src/generated/db"),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  report = checkTsConfig(path.join(root, "tsconfig.json"));
});

afterAll(() => {
  // Windows can hold the folder open for a while after a check (a virus scanner, say).
  removeTemporary(path.dirname(root));
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

  it("trusts nothing in a .d.ts of the project's own that claims to be generated", () => {
    expect(actual("src/spoof.ts", "viaApi")).toContain("unverifiable");
    expect(actual("src/spoof.ts", "viaMember")).toContain("unverifiable");
    expect(actual("src/spoof.ts", "viaFunction")).toContain("unverifiable");
  });

  // A client in a folder with its own package.json is a package. Prisma's own is covered by the
  // Prisma detector, as @prisma/client is; any other is listed as a package with no adapter.
  it("lists a folder with its own package.json unless it's a client prisma-client-js generated", () => {
    expect(report.unmapped.map((u) => u.package)).toEqual(["prisma-client-forged"]);
    expect(report.diagnostics.filter((d) => d.code === "PERM006").map((d) => `${path.basename(d.file)} ${d.function} ${d.capability}`)).toEqual([
      "forged.ts viaForged prisma-client-forged",
    ]);
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
    expect(db("noRelationsFluent")).toEqual(["db.read", "db.read(bare)"]);
    expect(db("noRelationsThen")).toEqual(["db.read(bare)"]);
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
    // Other methods on a model (findRaw, aggregateRaw) run a raw query, which can name
    // other collections ($lookup, $out): like $runCommandRaw, any table.
    ["otherMethod", ["db.read", "db.write"]],
    ["sqlHelper", []],
    // Passed along as a value, or called through .call, .apply, or .bind: arguments that can't be read.
    ["asValue", ["db.read", "db.read(lead)"]],
    ["viaCall", ["db.read", "db.write", "db.write(lead)"]],
    ["viaApply", ["db.read", "db.write", "db.write(lead)"]],
    ["viaBind", ["db.read", "db.write", "db.write(lead)"]],
    ["fluentValue", ["db.read", "db.read(lead)", "db.read(user)"]],
    // An extended client's operation names its model only where it's called on one.
    ["extendedValue", ["db.read", "db.write"]],
    ["extendedCall", ["db.read", "db.write"]],
    ["extendedAlias", ["db.read", "db.write"]],
    // A fluent step passed along could follow its relation with any arguments.
    ["extendedFluentValue", ["db.read", "db.read(lead)"]],
    ["extendedFluentAlias", ["db.read", "db.read(lead)"]],
    ["castClient", ["db.read(user)", "db.write(lead)"]],
    ["castModel", ["db.write(apiKey)"]],
    ["castThroughUnknown", ["db.write(user)"]],
    ["castStored", []],
    ["modelByName", ["db.read", "db.write"]],
    // These delegates share findMany's signature, so TypeScript resolves it to the first.
    ["modelByUnion", ["db.read", "db.read(lead)", "db.write"]],
    ["modelByRecord", ["db.read", "db.write"]],
    ["extendedByName", ["db.read", "db.write"]],
    ["modelByLiteral", ["db.read(lead)"]],
    ["otherComputed", ["db.read(lead)"]],
    ["extendedOther", ["db.read", "db.write"]],
    ["extendedThen", ["db.read(lead)"]],
    ["extendedAfterList", ["db.read(lead)", "db.read(user)"]],
  ];
  it.each(cases)("%s", (name, expected) => {
    expect(actual("src/default-client.ts", name)).toEqual(expected);
  });

  it("works the same with the prisma-client generator's files", () => {
    expect(actual("src/modern-client.ts", "write")).toEqual(["db.write(profile)", "db.write(user)"]);
  });

  // The value-use detector passes no call for `fn.call(thisArg, args)` today. Given that call,
  // the Prisma detector must still not read `thisArg` as the method's arguments.
  it("reads no arguments from a .call(...) it's handed", () => {
    const project = new Project({ tsConfigFilePath: path.join(root, "tsconfig.json") });
    const callOf = (file: string, callee: string) =>
      project.getSourceFileOrThrow(path.join(root, file)).getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getExpression().getText() === callee)!;
    const reach = (file: string, callee: string) => {
      const call = callOf(file, callee);
      const access = call.getExpression();
      if (!Node.isPropertyAccessExpression(access)) throw new Error(callee);
      const declaration = access.getExpression().getType().getCallSignatures()[0]!.getDeclaration();
      return prismaCapabilities(declaration, call).map((c) => (c.arg === undefined ? c.name : `${c.name}(${c.arg})`)).sort();
    };
    // A model's method: its table, and arguments that could reach any (not `prisma.lead`'s).
    expect(reach("src/default-client.ts", "prisma.lead.update.call")).toEqual(["db.read", "db.write", "db.write(lead)"]);
    // An extended client's operation, which names no model then.
    expect(reach("src/default-client.ts", "ext.lead.create.call")).toEqual(["db.read", "db.write"]);
    // The client's own method, which touches no table.
    expect(reach("src/middleware.ts", "prisma.$use.call")).toEqual([]);
  });
});

describe("query extensions", () => {
  // The callback is charged with the query it runs; calls through the extended client aren't
  // linked to it (a documented limit), so they reach only their own operation.
  it.each([
    // The intercepted operation, with the arguments given to `query`: spread arguments could name any relation.
    ["<anonymous>.findMany", ["db.read", "db.read(apiKey)", "db.read(lead)"]],
    ["<anonymous>.update", ["db.write(lead)", "db.write(tag)"]],
    ["<anonymous>.create", ["db.write(lead)", "db.write(user)"]],
    // Any operation of a model, or any model: any table.
    ["<anonymous>.$allOperations", ["db.read", "db.write"]],
    ["<anonymous>.findRaw", ["db.read", "db.write"]],
    // `query` passed along: whatever calls it runs any query.
    ["<anonymous>.findUnique", ["db.read", "db.write"]],
  ])("%s", (name, expected) => {
    expect(actual("src/extensions.ts", name)).toEqual(expected);
  });

  it.each([
    // Its relations aren't known, so a relation it names could be any table.
    ["<anonymous>.count", ["db.read", "db.read(lead)"]],
    ["<anonymous>.findMany", ["db.read", "db.read(lead)", "db.read(tag)"]],
    ["<anonymous>.update", ["db.read", "db.write"]],
    ["<anonymous>.create", ["db.read", "db.write"]],
    ["<anonymous>.findUnique", ["db.read", "db.write"]],
  ])("%s, taken from its arguments another way", (name, expected) => {
    expect(actual("src/extensions-more.ts", name)).toEqual(expected);
  });

  it("treats older clients' $use middleware calling next() as any query", () => {
    expect(actual("src/middleware.ts", "install")).toEqual(["db.read", "db.write"]);
    expect(actual("src/middleware.ts", "installTyped")).toEqual(["db.read", "db.write"]);
    // next() passed along to a function of the project's could run any query there.
    expect(actual("src/middleware.ts", "installForwarding")).toEqual(["db.read", "db.write"]);
    // A middleware passed around as a value runs nothing by itself.
    expect(actual("src/middleware.ts", "typedParameter")).toEqual([]);
  });

  it("treats a query extension for every model and operation as any query", () => {
    expect(actual("src/extensions-all.ts", "<anonymous>.$allOperations")).toEqual(["db.read", "db.write"]);
  });

  it("doesn't link a call through the extended client to the extension", () => {
    expect(actual("src/extensions.ts", "listLeads")).toEqual(["db.read(lead)"]);
  });
});
