// Built-in adapters for third-party packages, checked against stand-ins shaped like
// each package's real typings: the declaration a call resolves to decides which
// adapter entry applies, so the stand-ins keep the real names and shapes (classes,
// interfaces, call signatures). Each notes the version it was verified against.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAdapters } from "../src/adapters.js";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

// --- stand-ins for the packages, under node_modules ---------------------------------

const CURRENT: Record<string, string> = {
  // @types/pg 8: the query methods are on classes.
  "pg/index.d.ts": `
export class Pool { query(text: string, values?: unknown[]): Promise<unknown>; end(): Promise<void>; }`,

  // stripe 22.6.2: resources are classes; a few send to hosts other than api.stripe.com.
  "stripe/index.d.ts": `
declare class StripeResource {}
declare class RefundResource extends StripeResource { create(params?: object): Promise<unknown>; }
declare class CustomerResource extends StripeResource { retrieve(id: string): Promise<unknown>; }
declare class FileResource extends StripeResource { create(params: object): Promise<unknown>; retrieve(id: string): Promise<unknown>; }
declare class QuoteResource extends StripeResource { pdf(id: string): Promise<unknown>; }
declare class OAuthResource extends StripeResource {
  authorizeUrl(params?: object): string;
  token(params: object): Promise<unknown>;
  deauthorize(params: object): Promise<unknown>;
}
declare class MeterEventStreamResource extends StripeResource { create(params: object): Promise<void>; }
interface StripeConfig { apiVersion?: string; host?: string; port?: number; protocol?: string }
declare class Stripe {
  constructor(key: string, config?: StripeConfig);
  refunds: RefundResource;
  customers: CustomerResource;
  files: FileResource;
  quotes: QuoteResource;
  oauth: OAuthResource;
  v2: { billing: { meterEventStream: MeterEventStreamResource } };
  rawRequest(method: string, path: string, params?: object, options?: { apiBase?: string }): Promise<unknown>;
}
export default Stripe;
export type { StripeConfig };`,

  // tar 7.5: the commands are consts typed TarCommand, whose call signatures are in a type alias.
  "tar/index.d.ts": `
export type TarCommand<A, S> = { (): A; (opt: { file?: string; cwd?: string }, entries?: string[]): A } & { (opt: { sync: true }): S } & {
  // Each command also exposes the four functions it dispatches to.
  syncFile: (opt: { file: string; cwd?: string }, entries: string[]) => void;
  asyncFile: (opt: { file: string; cwd?: string }, entries: string[], cb?: (er?: Error) => unknown) => Promise<void>;
  syncNoFile: (opt: { cwd?: string }, entries: string[]) => S;
  asyncNoFile: (opt: { cwd?: string }, entries: string[]) => A;
  validate?: (opt: object, entries?: string[]) => void;
};
declare class Unpack { constructor(opt?: { cwd?: string }); }
declare class UnpackSync extends Unpack {}
declare class Pack { constructor(opt?: { cwd?: string }); add(path: string): this; }
declare class PackSync extends Pack { constructor(opt: { cwd?: string }); }
declare class WriteEntry { constructor(path: string, opt?: object); }
export declare const create: TarCommand<Pack, PackSync>;
export declare const extract: TarCommand<Unpack, UnpackSync>;
export declare const list: TarCommand<object, object>;
export declare const replace: TarCommand<Pack, PackSync>;
export declare const update: TarCommand<Pack, PackSync>;
export { create as c, extract as x, list as t, replace as r, update as u, Unpack, UnpackSync, Pack, PackSync, WriteEntry };`,

  // cheerio 1.2: fromURL fetches the page; load parses a string.
  "cheerio/index.d.ts": `
export declare function fromURL(url: string | URL, options?: object): Promise<unknown>;
export declare const load: (content: string) => unknown;`,

  // rxjs 7.8: ajax is a const of an interface with call signatures and methods.
  "rxjs/index.d.ts": `export declare function of<T>(value: T): unknown;`,
  "rxjs/ajax/index.d.ts": `
export interface AjaxConfig { url: string; method?: string }
export interface AjaxCreationMethod {
  <T>(config: AjaxConfig): unknown;
  <T>(url: string): unknown;
  get<T>(url: string, headers?: object): unknown;
  post<T>(url: string, body?: unknown, headers?: object): unknown;
  put<T>(url: string, body?: unknown, headers?: object): unknown;
  patch<T>(url: string, body?: unknown, headers?: object): unknown;
  delete<T>(url: string, headers?: object): unknown;
  getJSON<T>(url: string, headers?: object): unknown;
}
export declare const ajax: AjaxCreationMethod;`,
  "rxjs/fetch/index.d.ts": `export declare function fromFetch<T>(input: string | Request, init?: RequestInit): unknown;`,
  "rxjs/webSocket/index.d.ts": `
export interface WebSocketSubjectConfig<T> { url: string }
export declare class WebSocketSubject<T> { constructor(urlConfigOrSource: string | WebSocketSubjectConfig<T>); }
export declare function webSocket<T>(urlConfigOrSource: string | WebSocketSubjectConfig<T>): WebSocketSubject<T>;`,

  // @types/react-dom 19: resource hints are top-level functions.
  "@types/react-dom/index.d.ts": `
export function preinit(href: string, options?: { as: "script" | "style" }): void;
export function preinitModule(href: string, options?: object): void;
export function preload(href: string, options?: { as: string }): void;
export function preloadModule(href: string, options?: object): void;
export function preconnect(href: string, options?: object): void;
export function prefetchDNS(href: string): void;
export function flushSync<R>(fn: () => R): R;`,

  // @types/lodash 4.17: methods are on LoDashStatic and the chain wrappers, in namespace _.
  "@types/lodash/index.d.ts": `
declare const _: _.LoDashStatic;
declare namespace _ {
  type TemplateExecutor = (data?: object) => string;
  interface LoDashStatic {
    <T>(value: T): LoDashImplicitWrapper<T>;
    chain<T>(value: T): LoDashExplicitWrapper<T>;
    template(string?: string, options?: object): TemplateExecutor;
    map<T, R>(list: T[], fn: (value: T) => R): R[];
  }
  interface LoDashImplicitWrapper<T> { template(options?: object): TemplateExecutor; }
  interface LoDashExplicitWrapper<T> { template(options?: object): LoDashExplicitWrapper<TemplateExecutor>; }
}
export = _;`,
};

// Packages as other typings declare them: as plain functions.
const OLDER: Record<string, string> = {
  "rxjs/index.d.ts": `export declare function of<T>(value: T): unknown;`,
  "rxjs/ajax/index.d.ts": `export declare function ajax(urlOrConfig: string | { url: string }): unknown;`,
  "lodash/index.d.ts": `export declare function template(text: string): (data?: object) => string;`,
  // @types/tar 6: the commands are functions, with one-letter aliases.
  "@types/tar/index.d.ts": `
export function create(options: { file?: string }, fileList: ReadonlyArray<string>): Promise<void>;
export const c: typeof create;
export function extract(options: { file?: string; cwd?: string }, fileList?: ReadonlyArray<string>): Promise<void>;
export const x: typeof extract;
export function list(options?: { file?: string }): Promise<void>;
export const t: typeof list;
export function replace(options: { file: string }, fileList: ReadonlyArray<string>): Promise<void>;
export const r: typeof replace;
export function update(options: { file: string }, fileList: ReadonlyArray<string>): Promise<void>;
export const u: typeof update;`,
};

// A team's own adapter, which adds to what PermLang detects itself.
const TEAM_ADAPTER = {
  permlang: 1,
  package: "pg",
  defines: ["audit.query"],
  functions: { "Pool.query": ["audit.query"] },
};

const SOURCES: Record<string, string> = {
  "team.ts": `
import { Pool } from "pg";
const pool = new Pool();
/** @perm env(NONE) */ export function leads() { return pool.query("SELECT * FROM leads"); }
`,
  "pg-any.ts": `
import * as pg from "pg";
/** @perm env(NONE) */ export function constructed() { return new (pg as any).Pool().query("DELETE FROM users"); }
/** @perm env(NONE) */ export function typed() { return new pg.Pool().query("DELETE FROM users"); }
`,
  "stripe.ts": `
import Stripe, { type StripeConfig } from "stripe";
const stripe = new Stripe("sk_test_placeholder");
/** @perm env(NONE) */ export function otherHost() { return new Stripe("sk", { host: "evil.example" }); }
/** @perm env(NONE) */ export function otherHostAndPort() { return new Stripe("sk", { host: "evil.example:8443", protocol: "http" }); }
/** @perm env(NONE) */ export function unknownHost(host: string) { return new Stripe("sk", { host }); }
/** @perm env(NONE) */ export function configured(config: StripeConfig) { return new Stripe("sk", config); }
/** @perm env(NONE) */ export function plain() { return [new Stripe("sk"), new Stripe("sk", undefined), new Stripe("sk", { "apiVersion": "2025-01-01" }), new Stripe("sk", { apiVersion: "x" } as StripeConfig)]; }
/** @perm env(NONE) */ export function spread(base: StripeConfig) { return new Stripe("sk", { ...base, apiVersion: "x" }); }
/** @perm env(NONE) */ export function computed(key: "host" | "port") { return new Stripe("sk", { [key]: "evil.example" }); }
/** @perm env(NONE) */ export function refund() { return stripe.refunds.create({ charge: "ch_1" }); }
/** @perm env(NONE) */ export function customer() { return stripe.customers.retrieve("cus_1"); }
/** @perm env(NONE) */ export function upload() { return stripe.files.create({ purpose: "dispute_evidence" }); }
/** @perm env(NONE) */ export function quotePdf() { return stripe.quotes.pdf("qt_1"); }
/** @perm env(NONE) */ export function connect() { return [stripe.oauth.token({}), stripe.oauth.deauthorize({})]; }
/** @perm env(NONE) */ export function authorizeUrl() { return stripe.oauth.authorizeUrl({}); }
/** @perm env(NONE) */ export function meterEvents() { return stripe.v2.billing.meterEventStream.create({}); }
/** @perm env(NONE) */ export function raw() { return stripe.rawRequest("POST", "/v1/files", {}, { apiBase: "files" }); }
`,
  "tar.ts": `
import * as tar from "tar";
/** @perm env(NONE) */ export function extract(f: string) { return [tar.x({ file: f, cwd: "/" }), tar.extract({ file: f })]; }
/** @perm env(NONE) */ export function create(f: string) { return [tar.c({ file: f }, ["a"]), tar.r({ file: f }, ["b"]), tar.u({ file: f }, ["c"])]; }
/** @perm env(NONE) */ export function list(f: string) { return tar.t({ file: f }); }
/** @perm env(NONE) */ export function unpack() { return [new tar.Unpack({ cwd: "/" }), new tar.UnpackSync({ cwd: "/" })]; }
/** @perm env(NONE) */ export function pack() { return [new tar.Pack({ cwd: "/" }), new tar.PackSync({ cwd: "/" }), new tar.WriteEntry("a")]; }
/** @perm env(NONE) */ export function syncFile(f: string) { return tar.x.syncFile({ file: f, cwd: "/" }, []); }
/** @perm env(NONE) */ export function asyncFile(f: string) { return tar.r.asyncFile({ file: f }, ["/etc/passwd"]); }
/** @perm env(NONE) */ export function syncNoFile() { return tar.x.syncNoFile({ cwd: "/" }, []); }
/** @perm env(NONE) */ export function asyncNoFile() { return tar.c.asyncNoFile({ cwd: "/" }, ["/etc"]); }
/** @perm env(NONE) */ export function check(f: string) { return tar.x.validate?.({ file: f }); }
`,
  "cheerio.ts": `
import { fromURL, load } from "cheerio";
/** @perm env(NONE) */ export function remote() { return fromURL("https://evil.example/page"); }
/** @perm env(NONE) */ export function local() { return load("<p>x</p>"); }
`,
  "rxjs.ts": `
import { of } from "rxjs";
import { ajax } from "rxjs/ajax";
import { fromFetch } from "rxjs/fetch";
import { WebSocketSubject, webSocket } from "rxjs/webSocket";
/** @perm env(NONE) */ export function viaAjax() { return [ajax("https://a.example/x"), ajax({ url: "https://b.example/x" })]; }
/** @perm env(NONE) */ export function viaAjaxMethods() { return [ajax.get("https://c.example/"), ajax.post("https://c.example/"), ajax.put("https://c.example/"), ajax.patch("https://c.example/"), ajax.delete("https://c.example/"), ajax.getJSON("https://c.example/")]; }
/** @perm env(NONE) */ export function viaFetch() { return fromFetch("https://d.example/x"); }
/** @perm env(NONE) */ export function viaSocket() { return [webSocket("wss://e.example/"), new WebSocketSubject({ url: "wss://f.example/" })]; }
/** @perm env(NONE) */ export function local() { return of(1); }
`,
  "react-dom.ts": `
import { flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule } from "react-dom";
/** @perm env(NONE) */ export function runsScript() { preinit("https://cdn.example/x.js", { as: "script" }); }
/** @perm env(NONE) */ export function runsModule() { preinitModule("https://cdn.example/x.mjs"); }
/** @perm env(NONE) */ export function hints() { preload("https://a.example/f.woff2", { as: "font" }); preloadModule("https://b.example/m.js"); preconnect("https://c.example"); prefetchDNS("https://d.example"); }
/** @perm env(NONE) */ export function local() { return flushSync(() => 1); }
`,
  "lodash.ts": `
import _, { template } from "lodash";
/** @perm env(NONE) */ export function named() { return template("<%= x %>"); }
/** @perm env(NONE) */ export function onStatic() { return _.template("<%= x %>"); }
/** @perm env(NONE) */ export function chained() { return [_.chain("<%= x %>").template(), _("<%= x %>").template()]; }
/** @perm env(NONE) */ export function local() { return _.map([1], (n) => n + 1); }
`,
};

const OLDER_SOURCES: Record<string, string> = {
  "functions.ts": `
import { ajax } from "rxjs/ajax";
import { template } from "lodash";
/** @perm env(NONE) */ export function viaAjax() { return ajax("https://a.example/x"); }
/** @perm env(NONE) */ export function viaTemplate() { return template("<%= x %>"); }
`,
  "tar.ts": `
import * as tar from "tar";
/** @perm env(NONE) */ export function extract(f: string) { return [tar.x({ file: f }), tar.extract({ file: f })]; }
/** @perm env(NONE) */ export function replace(f: string) { return tar.r({ file: f }, ["/etc/passwd"]); }
/** @perm env(NONE) */ export function update(f: string) { return tar.u({ file: f }, ["a"]); }
/** @perm env(NONE) */ export function create(f: string) { return tar.c({ file: f }, ["a"]); }
/** @perm env(NONE) */ export function list(f: string) { return [tar.t({ file: f }), tar.list({ file: f })]; }
`,
};

const roots: string[] = [];
let current: Report;
let older: Report;

/** Writes a project with these packages and sources, and checks it. */
function project(packages: Record<string, string>, sources: Record<string, string>, adapters: object[] = []): { root: string; report: Report } {
  const root = mkdtempSync(path.join(tmpdir(), "permlang-packages-"));
  roots.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true, lib: ["ES2022", "DOM"], types: [] },
      include: ["src/*.ts"],
    }),
  };
  for (const [file, text] of Object.entries(packages)) {
    const name = file.startsWith("@") ? file.split("/").slice(0, 2).join("/") : file.split("/")[0]!;
    files[`node_modules/${file}`] = text;
    files[`node_modules/${name}/package.json`] ??= JSON.stringify({ name, types: "index.d.ts" });
  }
  for (const [file, text] of Object.entries(sources)) files[`src/${file}`] = text;
  const adapterFiles = adapters.map((a, i) => {
    files[`adapter-${i}.json`] = JSON.stringify(a);
    return path.join(root, `adapter-${i}.json`);
  });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return { root, report: checkTsConfig(path.join(root, "tsconfig.json"), { adapters: adapterFiles }) };
}

beforeAll(() => {
  current = project(CURRENT, SOURCES, [TEAM_ADAPTER]).report;
  older = project(OLDER, OLDER_SOURCES).report;
});

afterAll(() => {
  for (const root of roots) removeTemporary(root);
});

/** What a function reaches, sorted. */
function actual(file: string, name: string, report = current): string[] {
  const fn = report.functions.find((f) => f.file.replaceAll("\\", "/").endsWith(`/src/${file}`) && f.name === name);
  expect(fn, `${file}:${name}`).toBeDefined();
  return [...fn!.actual].sort();
}

describe("adapters on top of built-in detection", () => {
  it("adds a team adapter's capabilities to a database client's tables", () => {
    expect(actual("team.ts", "leads")).toEqual(["audit.query", "db.read(leads)"]);
  });
});

// What a package's class builds, past a cast, is `any`: nothing called on it can be checked.
describe("a package's class constructed past a cast", () => {
  it("is unverifiable when what it builds reaches a capability", () => expect(actual("pg-any.ts", "constructed")).toEqual(["unverifiable"]));
  it("is checked as usual without the cast", () => expect(actual("pg-any.ts", "typed")).toEqual(["audit.query", "db.write(users)"]));
});

describe("stripe", () => {
  it.each([
    // A host in the client's config is where every call goes.
    ["otherHost", ["net(evil.example)"]],
    ["otherHostAndPort", ["net(evil.example)"]],
    ["unknownHost", ["net"]],
    ["configured", ["net"]],
    ["plain", []],
    ["spread", ["net"]],
    ["computed", ["net"]],
    ["refund", ["net(api.stripe.com)", "payments.refund"]],
    ["customer", ["net(api.stripe.com)"]],
    // Calls that Stripe sends to its other hosts.
    ["upload", ["net(files.stripe.com)"]],
    ["quotePdf", ["net(files.stripe.com)"]],
    ["connect", ["net(connect.stripe.com)"]],
    ["authorizeUrl", []],
    ["meterEvents", ["net(meter-events.stripe.com)"]],
    ["raw", ["net(api.stripe.com)", "net(connect.stripe.com)", "net(files.stripe.com)", "net(meter-events.stripe.com)"]],
  ])("%s", (name, expected) => {
    expect(actual("stripe.ts", name)).toEqual(expected);
  });
});

describe("tar", () => {
  it.each([
    ["extract", ["fs.read", "fs.write"]],
    ["create", ["fs.read", "fs.write"]],
    // tar 7 types every command alike, so listing counts as a write too.
    ["list", ["fs.read", "fs.write"]],
    ["unpack", ["fs.write"]],
    ["pack", ["fs.read"]],
    // The functions each command dispatches to, called directly: these extract or write too.
    ["syncFile", ["fs.read", "fs.write"]],
    ["asyncFile", ["fs.read", "fs.write"]],
    ["syncNoFile", ["fs.read", "fs.write"]],
    ["asyncNoFile", ["fs.read", "fs.write"]],
    // Checking the options touches nothing.
    ["check", []],
  ])("tar 7: %s", (name, expected) => {
    expect(actual("tar.ts", name)).toEqual(expected);
  });

  it.each([
    ["extract", ["fs.read", "fs.write"]],
    ["replace", ["fs.read", "fs.write"]],
    ["update", ["fs.read", "fs.write"]],
    ["create", ["fs.read", "fs.write"]],
    ["list", ["fs.read"]],
  ])("tar 6: %s", (name, expected) => {
    expect(actual("tar.ts", name, older)).toEqual(expected);
  });
});

describe("other typings' shapes", () => {
  it.each([
    ["viaAjax", ["net(a.example)"]],
    ["viaTemplate", ["unverifiable"]],
  ])("%s", (name, expected) => {
    expect(actual("functions.ts", name, older)).toEqual(expected);
  });
});

describe("tar's aliases", () => {
  // Typings so far declare c, x, t, r, and u as consts of the commands' types, and
  // give UnpackSync and WriteEntrySync no constructor of their own, so calls resolve
  // to the command or base class. The others are mapped in case a typing declares them.
  it("maps each alias like what it stands for", () => {
    const tar = loadAdapters([]).adapters.find((a) => a.package === "tar")!;
    const pairs = [["c", "create"], ["x", "extract"], ["t", "list"], ["r", "replace"], ["u", "update"],
      ["UnpackSync.constructor", "Unpack.constructor"], ["WriteEntrySync.constructor", "WriteEntry.constructor"]];
    for (const [alias, original] of pairs) {
      expect(tar.functions.get(alias!), alias).toEqual(tar.functions.get(original!));
      expect(tar.functions.get(alias!), alias).toBeDefined();
    }
  });
});

describe("network and code in otherwise pure packages", () => {
  it.each([
    ["cheerio.ts", "remote", ["net(evil.example)"]],
    ["cheerio.ts", "local", []],
    ["rxjs.ts", "viaAjax", ["net(a.example)", "net(b.example)"]],
    ["rxjs.ts", "viaAjaxMethods", ["net(c.example)"]],
    ["rxjs.ts", "viaFetch", ["net(d.example)"]],
    ["rxjs.ts", "viaSocket", ["net(e.example)", "net(f.example)"]],
    ["rxjs.ts", "local", []],
    // preinit runs the script it loads.
    ["react-dom.ts", "runsScript", ["net(cdn.example)", "unverifiable"]],
    ["react-dom.ts", "runsModule", ["net(cdn.example)", "unverifiable"]],
    ["react-dom.ts", "hints", ["net(a.example)", "net(b.example)", "net(c.example)", "net(d.example)"]],
    ["react-dom.ts", "local", []],
    // template compiles its text into a function.
    ["lodash.ts", "named", ["unverifiable"]],
    ["lodash.ts", "onStatic", ["unverifiable"]],
    ["lodash.ts", "chained", ["unverifiable"]],
    ["lodash.ts", "local", []],
  ])("%s %s", (file, name, expected) => {
    expect(actual(file, name)).toEqual(expected);
  });
});
