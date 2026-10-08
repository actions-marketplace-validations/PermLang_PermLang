// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Globals whose types come from somewhere other than lib.dom: Node's web globals (typed by
// undici-types), `process` when Node's types are missing, and Vite's import.meta.env. Each
// runs as its own project, since the shared fixtures have both lib.dom and @types/node.
// Found in the 0.3 review.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

function check(compilerOptions: object, files: Record<string, string>): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-globals-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, typeRoots, ...compilerOptions },
    include: ["*.ts"],
  }));
  for (const [name, code] of Object.entries(files)) writeFileSync(path.join(dir, name), code);
  return checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}

afterAll(() => dirs.forEach(removeTemporary));

const errors = (report: Report, fn: string) =>
  report.diagnostics.filter((d) => d.function === fn && d.severity === "error").map((d) => `${d.code} ${d.capability}`);

describe("Node's web globals, without lib.dom", () => {
  const report = check({ lib: ["ES2022"], types: ["node"] }, {
    "app.ts": [
      "/** @perm env(MODE) */",
      "export function ws() { return new WebSocket(\"wss://evil.example/x\"); }",
      "/** @perm env(MODE) */",
      "export function wsAlias() { const W = WebSocket; return new W(\"wss://evil.example/x\"); }",
      "/** @perm env(MODE) */",
      "export async function web() { const r = new Response(\"x\"); return [new Headers({ a: \"b\" }).get(\"a\"), await r.text(), new Request(\"https://good.example/\").url, new FormData()]; }",
    ].join("\n"),
  });

  it("finds WebSocket, also through an alias", () => {
    expect(errors(report, "ws")).toEqual(["PERM001 net(evil.example)"]);
    expect(errors(report, "wsAlias")).toEqual(["PERM001 net(evil.example)"]);
  });

  it("maps undici-types, so Headers, Request, and Response aren't unmapped", () => {
    expect(errors(report, "web")).toEqual([]);
    expect(report.unmapped.map((u) => u.package)).not.toContain("undici-types");
    expect(report.diagnostics.filter((d) => d.code === "PERM006")).toEqual([]);
  });
});

describe("process without Node's types", () => {
  const report = check({ lib: ["ES2022"], types: [] }, {
    "app.ts": [
      "/** @perm env(STRIPE_KEY) */",
      "export function key() { return process.env.STRIPE_KEY; }",
      "/** @perm env(STRIPE_KEY) */",
      "export function other() { return process.env[\"OTHER\"]; }",
      "/** @perm env(STRIPE_KEY) */",
      "export function stop() { process.kill(1); }",
      "/** @perm env(STRIPE_KEY) */",
      "export function cast() { return (process as any).env.SECRET; }",
    ].join("\n"),
    "worker.ts": "// A second file that uses process too.\n/** @perm env(PORT) */\nexport function port() { return process.env.PORT; }",
  });

  it("still reads environment variables by name", () => {
    expect(errors(report, "key")).toEqual([]);
    expect(errors(report, "other")).toEqual(["PERM001 env(OTHER)"]);
    expect(errors(report, "cast")).toEqual(["PERM001 env(SECRET)"]);
    expect(errors(report, "port")).toEqual([]);
  });

  it("warns once, at the first file that uses it, that the rest of process can't be checked", () => {
    const d = report.diagnostics.filter((x) => x.code === "PERM007");
    expect(d.map((x) => `${x.severity} ${x.capability} ${path.basename(x.file)}:${x.line}`)).toEqual(["warning node:process app.ts:2"]);
    expect(d[0]!.fix).toBe("install @types/node.");
    expect(report.unresolved).toEqual(["node:process"]);
  });

  it("reads a project's own `declare const process` the same way, without the warning", () => {
    const shimmed = check({ lib: ["ES2022"], types: [] }, {
      "shim.d.ts": "declare const process: { env: Record<string, string | undefined> };",
      "app.ts": "/** @perm env(A) */\nexport function b() { return process.env.B; }",
    });
    expect(errors(shimmed, "b")).toEqual(["PERM001 env(B)"]);
    expect(shimmed.unresolved).toEqual([]);
    // Declared in the file that uses it, as a bundler's config might.
    const inline = check({ lib: ["ES2022"], types: [] }, {
      "app.ts": "declare const process: { env: Record<string, string | undefined> };\n/** @perm env(A) */\nexport function b() { return process.env.B; }",
    });
    expect(errors(inline, "b")).toEqual(["PERM001 env(B)"]);
  });

  it("leaves a local variable named process alone", () => {
    const local = check({ lib: ["ES2022"], types: [] }, {
      "app.ts": "export function b() { const process = { env: { B: \"1\" } }; return process.env.B; }",
    });
    expect(local.diagnostics).toEqual([]);
  });
});

describe("import.meta.env", () => {
  const files = {
    "app.ts": [
      "/** @perm env(VITE_API_URL) */",
      "export function url() { return import.meta.env.VITE_API_URL; }",
      "/** @perm env(VITE_API_URL) */",
      "export function secret() { return import.meta.env.VITE_SECRET_KEY; }",
      "/** @perm env(VITE_API_URL) */",
      "export function mode() { return import.meta.env.DEV ? import.meta.env.MODE : \"\"; }",
      "/** @perm env(VITE_API_URL) */",
      "export function built() { const { BASE_URL, SSR } = import.meta.env; return [BASE_URL, SSR, import.meta.env[\"PROD\"]]; }",
      "/** @perm env(VITE_API_URL) */",
      "export function whole() { return { ...import.meta.env }; }",
      "/** @perm env(VITE_API_URL) */",
      "export function alias() { const env = import.meta.env; return env.VITE_TOKEN; }",
      "/** @perm env(VITE_API_URL) */",
      "export function metaAlias() { const m = import.meta; return m.env.VITE_TOKEN; }",
      "/** @perm env(VITE_API_URL) */",
      "export function metaBracket() { return import.meta[\"env\"].VITE_TOKEN; }",
      "/** @perm env(VITE_API_URL) */",
      "export function metaDestructured() { const { env } = import.meta; return env.VITE_TOKEN; }",
      "/** @perm env(VITE_API_URL) */",
      "export function metaNested() { const { env: { VITE_TOKEN, MODE } } = import.meta; return [VITE_TOKEN, MODE]; }",
    ].join("\n"),
  };
  // What vite/client declares.
  const viteTypes = "interface ImportMetaEnv { readonly [key: string]: any; BASE_URL: string; MODE: string; DEV: boolean; PROD: boolean; SSR: boolean }\ninterface ImportMeta { readonly env: ImportMetaEnv }";

  for (const [name, report] of [
    ["with Vite's types", check({ lib: ["ES2022", "DOM"], types: [] }, { ...files, "env.d.ts": viteTypes })],
    ["without types", check({ lib: ["ES2022", "DOM"], types: [] }, files)],
  ] as const) {
    describe(name, () => {
      it("reads variables by name", () => {
        expect(errors(report, "url")).toEqual([]);
        expect(errors(report, "secret")).toEqual(["PERM001 env(VITE_SECRET_KEY)"]);
        expect(errors(report, "whole")).toEqual(["PERM001 env"]);
      });

      it("ignores what Vite sets itself (MODE, DEV, PROD, SSR, BASE_URL)", () => {
        expect(errors(report, "mode")).toEqual([]);
        expect(errors(report, "built")).toEqual([]);
      });

      it("follows an alias, or reads every variable through one it can't follow", () => {
        expect(errors(report, "alias")).toEqual([name === "without types" ? "PERM001 env" : "PERM001 env(VITE_TOKEN)"]);
      });

      it("reads through an alias of import.meta, a quoted `env`, and destructuring", () => {
        for (const fn of ["metaAlias", "metaBracket", "metaDestructured", "metaNested"]) expect(errors(report, fn), fn).toEqual(["PERM001 env(VITE_TOKEN)"]);
      });
    });
  }
});

describe("process without Node's types, reached another way", () => {
  const report = check({ lib: ["ES2022"], types: [] }, {
    "app.ts": [
      "/** @perm env(A) */",
      "export function viaGlobal() { return globalThis.process.env.B; }",
      "/** @perm env(A) */",
      "export function destructured() { const { env } = process; return env.C; }",
      "/** @perm env(A) */",
      "export function aliased() { const p = process; return p.env.D; }",
      "/** @perm env(A) */",
      "export function bracket() { return process[\"env\"].E; }",
      "/** @perm env(A) */",
      "export function renamed() { const { env: e } = globalThis.process; return [e.F, e]; }",
      "/** @perm env(A) */",
      "export function nested() { const { env: { G } } = process; return G; }",
      "/** @perm env(A) */",
      "export function lookalikes(o: { env: { H: string } }) { const { env } = o; const local = { env: { I: \"1\" } }; return [env.H, local.env.I]; }",
      "/** @perm env(A) */",
      "export function parameter({ env } = process) { return env.J; }",
      "/** @perm env(A) */",
      "export function nestedGlobal() { const { process: { env } } = globalThis; return env.K; }",
      "/** @perm env(A) */",
      "export function moreLookalikes({ env: given }: { env: { L: string } }) { const { env: own } = globalThis; const { other: { env: theirs } } = globalThis; const holder = { process: { env: { M: \"1\" } } }; const { process: { env: held } } = holder; const [{ env: listed }] = [{ env: { Q: \"1\" } }]; return [given.L, own.N, theirs.O, holder.process.env.M, held.P, listed.Q, undeclared.env.R]; }",
    ].join("\n"),
  });
  const sorted = (fn: string) => errors(report, fn).sort();

  it("reads variables by name", () => {
    expect(sorted("viaGlobal")).toEqual(["PERM001 env(B)"]);
    expect(sorted("destructured")).toEqual(["PERM001 env(C)"]);
    expect(sorted("aliased")).toEqual(["PERM001 env(D)"]);
    expect(sorted("bracket")).toEqual(["PERM001 env(E)"]);
    expect(sorted("renamed")).toEqual(["PERM001 env", "PERM001 env(F)"]);
    expect(sorted("nested")).toEqual(["PERM001 env(G)"]);
    expect(sorted("parameter")).toEqual(["PERM001 env(J)"]);
    expect(sorted("nestedGlobal")).toEqual(["PERM001 env(K)"]);
    expect(sorted("lookalikes")).toEqual([]);
    // A parameter given from outside, `globalThis.env`, another global member, a local object's `process`,
    // an array's element, and a name nothing declares.
    expect(sorted("moreLookalikes")).toEqual([]);
  });

  it("warns that the rest of process can't be checked, at globalThis.process too", () => {
    expect(report.diagnostics.filter((d) => d.code === "PERM007").map((d) => `${d.capability} ${path.basename(d.file)}:${d.line}`)).toEqual(["node:process app.ts:2"]);
  });
});

describe("web workers", () => {
  const report = check({ lib: ["ES2022", "WebWorker"], types: [] }, {
    "worker.ts": [
      "/** @perm net(cdn.example) */",
      "export function load() { importScripts(\"https://cdn.example/lib.js\"); }",
      "/** @perm net(cdn.example) */",
      "export function get() { return self.fetch(\"https://cdn.example/data.json\"); }",
      "/** @perm net(cdn.example) */",
      "export function loadSelf() { self.importScripts(\"https://cdn.example/lib.js\"); }",
      "/** @perm net(cdn.example) */",
      "export function loadAlias() { const i = self.importScripts; i(\"https://cdn.example/lib.js\"); }",
      "/** @perm net(cdn.example) */",
      "export function loadDestructured() { const { importScripts: i } = self; [\"https://cdn.example/lib.js\"].forEach(i); }",
      "/** @perm net(cdn.example) */",
      "export function register() { return navigator.serviceWorker.register(\"/sw.js\"); }",
    ].join("\n"),
  });

  it("treats importScripts as code it can't see", () => expect(errors(report, "load")).toEqual(["PERM004 unverifiable"]));
  it("still reads self.fetch's host", () => expect(errors(report, "get")).toEqual([]));
  it("matches importScripts as the worker scope's method too", () => {
    for (const fn of ["loadSelf", "loadAlias", "loadDestructured"]) expect(errors(report, fn), fn).toEqual(["PERM004 unverifiable"]);
  });
  it("treats registering a service worker as code it can't see", () => expect(errors(report, "register")).toEqual(["PERM004 unverifiable"]));
});

// Without Node's types, setTimeout is only the browser's, which evaluates a string handler.
describe("browser timers, without Node's types", () => {
  const report = check({ lib: ["ES2022", "DOM"], types: [] }, {
    "timers.ts": [
      "/** @perm env(MODE) */",
      "export function forEachCode(codes: string[]) { codes.forEach(setTimeout); }",
      "/** @perm env(MODE) */",
      "export function thenCode(code: string) { return Promise.resolve(code).then(setTimeout); }",
      "/** @perm env(MODE) */",
      "export function reflectCode() { Reflect.apply(setTimeout, window, [\"alert(1)\"]); }",
      "/** @perm env(MODE) */",
      "export function stored() { return { later: setTimeout }; }",
      "/** @perm env(MODE) */",
      "export function handlerType(h: TimerHandler) { setTimeout(h, 0); }",
      "/** @perm env(MODE) */",
      "export function handlerAny(body: string) { setTimeout(JSON.parse(body).code, 0); }",
      "/** @perm env(MODE) */",
      "export function handlerUnknown(h: unknown) { setTimeout(h as TimerHandler, 0); }",
      "/** @perm env(MODE) */",
      "export function handlerUnion(h: string | (() => void)) { window.setTimeout(h, 0); }",
      "/** @perm env(MODE) */",
      "export function functions(h: () => void, f: Function) { setTimeout(h, 0); setTimeout(f, 0); [h].forEach(setTimeout); setTimeout.call(window, h, 1); Reflect.apply(setTimeout, window, [h, 1]); const schedule = window.setTimeout.bind(window); schedule(h, 2); setTimeout.bind(window, h, 3)(); return Promise.resolve(h).then(setInterval); }",
      "/** @perm env(MODE) */",
      "export function boundInPlace(codes: string[]) { codes.forEach(window.setTimeout.bind(window)); }",
      "/** @perm env(MODE) */",
      "export function boundStored(codes: string[]) { const later = window.setTimeout.bind(window); codes.forEach(later); }",
      "/** @perm env(MODE) */",
      "export function boundArgument() { const run = setTimeout.bind(window, \"alert(1)\"); run(); }",
      "/** @perm env(MODE) */",
      "export function bindMethod(wrap: (f: unknown) => void) { wrap(setTimeout.bind); return [window.setInterval.bind]; }",
    ].join("\n"),
  });

  it("treats a timer that may be given a string as unverifiable", () => {
    // `bindMethod` hands out the timer's own `bind`, which makes copies nothing checks the calls of.
    for (const fn of ["forEachCode", "thenCode", "reflectCode", "stored", "handlerType", "handlerAny", "handlerUnknown", "handlerUnion", "boundInPlace", "boundStored", "boundArgument", "bindMethod"]) {
      expect(errors(report, fn), fn).toEqual(["PERM004 unverifiable"]);
    }
  });
  it("leaves timers given only functions alone", () => expect(errors(report, "functions")).toEqual([]));
});

// Browser APIs that load a script the checker can't see, like a Worker.
describe("script loaders", () => {
  const report = check({ lib: ["ES2022", "DOM"], types: [] }, {
    "app.ts": [
      "/** @perm env(MODE) */",
      "export function worklet(ctx: AudioContext) { return ctx.audioWorklet.addModule(\"/w.js\"); }",
      "/** @perm env(MODE) */",
      "export function register() { return navigator.serviceWorker.register(\"/sw.js\"); }",
      "/** @perm env(MODE) */",
      "export function lookalikes() { const registry = { register: (x: string) => x, addModule: (x: string) => x }; return [registry.register(\"/sw.js\"), registry.addModule(\"/w.js\"), navigator.serviceWorker.getRegistrations()]; }",
    ].join("\n"),
  });

  it("treats a worklet module and a service worker as unverifiable", () => {
    expect(errors(report, "worklet")).toEqual(["PERM004 unverifiable"]);
    expect(errors(report, "register")).toEqual(["PERM004 unverifiable"]);
  });
  it("leaves look-alikes alone", () => expect(errors(report, "lookalikes")).toEqual([]));
});

describe("a project's own declarations", () => {
  // An SDK loaded by a script tag, typed by hand. Its classes aren't the platform's.
  const report = check({ lib: ["ES2022", "DOM"], types: [] }, {
    "sdk.d.ts": "declare const sdk: { Client: { new (url: string): { send(body: string): void } } };\ndeclare class Tracker { constructor(url: string); }",
    "app.ts": "/** @perm env(MODE) */\nexport function connect() { new sdk.Client(\"https://sdk.example\").send(\"x\"); return new Tracker(\"https://t.example\"); }",
  });

  it("aren't mistaken for the platform's network classes", () => expect(errors(report, "connect")).toEqual([]));
});
