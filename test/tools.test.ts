// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Tools given to AI models. A function registered as a tool can be called by whoever
// controls the model's input, so prompt injection can trigger anything the tool reaches.
// PermLang finds tool registrations, works out what each handler reaches, and warns when
// a model can trigger something dangerous.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type CheckOptions, type Report } from "../src/check.js";
import { publishedPackages } from "./ai-packages.js";
import { removeTemporary } from "./temporary.js";

const typeRoots = [path.resolve("node_modules/@types")];

// Just enough of each framework's types to resolve calls to them.
const frameworks = `
// Shaped like the real AI SDK v7: tool() lives in @ai-sdk/provider-utils under a bundler-renamed
// name (tool$1), and ai re-exports it.
declare module "@ai-sdk/provider-utils" {
  function tool$1<T>(definition: T): T;
  export { tool$1 as tool };
}
declare module "ai" {
  export { tool } from "@ai-sdk/provider-utils";
  export function generateText(options: object): Promise<{ text: string }>;
}
declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  export class McpServer {
    constructor(info: object);
    tool(name: string, schema: object, handler: (args: any) => unknown): void;
    registerTool(name: string, config: object, handler: (args: any) => unknown): void;
    sendLoggingMessage(message: object): Promise<void>;
  }
}
declare module "@modelcontextprotocol/sdk/client/streamableHttp.js" {
  export class StreamableHTTPClientTransport {
    constructor(url: URL);
  }
}
declare module "@modelcontextprotocol/sdk/server/index.js" {
  export class Server {
    constructor(info: object, options: object);
    setRequestHandler(schema: object, handler: (request: any) => unknown): void;
  }
}
declare module "@modelcontextprotocol/sdk/types.js" {
  export const CallToolRequestSchema: object;
  export const ListToolsRequestSchema: object;
}
declare module "untyped-runner";
declare module "task-runner" {
  export function tool(definition: { execute: () => unknown }): void;
  export function runAll(options: { tools: Record<string, { execute: () => unknown }> }): void;
}
declare module "@anthropic-ai/sdk" {
  export default class Anthropic {
    messages: { create(options: { model: string; tools?: { name: string; description?: string; input_schema: object }[] }): Promise<unknown> };
  }
}
declare module "@openai/agents" {
  export function tool<T>(definition: T): T;
}
declare module "@langchain/core/tools" {
  export class DynamicStructuredTool {
    constructor(fields: { name: string; description: string; schema: object; func: (input: any) => unknown });
  }
}
`;

const sources: Record<string, string> = {
  vercel: `import { tool } from "ai";
import { execSync } from "node:child_process";
export const tools = {
  deleteUser: tool({
    description: "Delete a user",
    inputSchema: {},
    execute: async ({ id }: { id: string }) => execSync("rm -rf /users/" + id),
  }),
  weather: tool({ description: "Weather", inputSchema: {}, execute: async () => fetch("https://api.weather.example/today") }),
};`,
  mcp: `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync } from "node:fs";
export function start() {
  const server = new McpServer({ name: "notes" });
  server.registerTool("save_note", { description: "Save a note" }, async ({ text }: { text: string }) => {
    writeFileSync("./notes/" + Date.now(), text);
  });
  // Talking to the connected client isn't network access.
  server.tool("ping", {}, async () => {
    await server.sendLoggingMessage({ level: "info", data: "ping" });
    return { ok: true };
  });
  return server;
}`,
  client: `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export function connectRemote() {
  return new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"));
}`,
  lowlevel: `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
export function serve(server: Server) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    runCommand(request.params.name);
  });
}
function runCommand(name: string) {
  spawn(name);
}`,
  byReference: `import { tool } from "@openai/agents";
import { rmSync } from "node:fs";
function wipe() {
  rmSync("./cache", { recursive: true });
}
export const cleanupTool = tool({ name: "cleanup", description: "Clear the cache", execute: wipe });`,
  anyHost: `import { tool } from "@openai/agents";
export const browseTool = tool({ name: "browse", description: "Fetch a page", execute: async ({ url }: { url: string }) => (await fetch(url)).text() });`,
  langchain: `import { DynamicStructuredTool } from "@langchain/core/tools";
import { exec } from "node:child_process";
export const shellTool = new DynamicStructuredTool({ name: "shell", description: "Run a command", schema: {}, func: async ({ cmd }: { cmd: string }) => exec(cmd) });`,
  notAnAiPackage: `import { runAll, tool } from "task-runner";
import { execSync } from "node:child_process";
export const job = tool({ execute: () => execSync("make") });
export const all = runAll({ tools: { build: { execute: () => execSync("make") } } });`,
  // A tool list the app answers itself: a schema for the model, no handler for the SDK to run.
  schemaOnly: `import Anthropic from "@anthropic-ai/sdk";
export function ask(client: Anthropic) {
  return client.messages.create({ model: "claude", tools: [{ name: "get_weather", description: "Weather", input_schema: {} }] });
}`,
  // No name anywhere: not in the call, not in its options, not where it's stored.
  unnamed: `import { tool } from "ai";
export const toolList = [tool({ description: "Say hello", inputSchema: {}, execute: async () => "hello" })];`,
  notATool: `import { generateText } from "ai";
export async function summarize(text: string) {
  return generateText({ prompt: text });
}`,
  // Found in review: a schema property named \`run\` was taken for the handler, and tools that
  // read whatever file or variable the model names weren't flagged.
  mcpSchemaRun: `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
export function serveFiles(s: McpServer) {
  s.tool("run_command", { run: "boolean" }, async ({ cmd }: { cmd: string }) => execSync(cmd));
  s.tool("read_file", {}, async ({ path }: { path: string }) => readFileSync(path, "utf8"));
  s.tool("dump_env", {}, async () => JSON.stringify(process.env));
  s.tool("read_readme", {}, async () => readFileSync("./README.md", "utf8"));
}`,
  // Shorthand \`{ execute }\` names a function declared elsewhere.
  shorthand: `import { tool } from "@openai/agents";
import { execSync } from "node:child_process";
async function execute({ cmd }: { cmd: string }) {
  return execSync(cmd).toString();
}
export const runTool = tool({ name: "run", description: "Run a command", execute });
// \`run\` here is a setting, not the handler.
export const deployTool = tool({ name: "deploy", description: "Deploy", run: "nightly", execute: async () => execSync("make deploy") });`,
  // A library function as the handler, cast to any as such code often is; and one passed in from elsewhere.
  byLibrary: `import { tool } from "@openai/agents";
import { execSync } from "node:child_process";
export const rawTool = tool({ name: "raw", description: "Run a command", execute: execSync as any });
export function make(handler: (input: string) => string) {
  return tool({ name: "injected", description: "Whatever it is given", execute: handler });
}`,
  // Definitions and handlers PermLang can or can't follow.
  indirect: `import { tool } from "@openai/agents";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { execSync } from "node:child_process";
const definition = { name: "held", description: "Held in a constant", execute: async () => execSync("make") };
export const heldTool = tool(definition);
export function fromParameter(options: { name: string; execute: () => unknown }) {
  return tool(options);
}
const base = { description: "Spread from elsewhere" };
export const spreadTool = tool({ ...base, name: "spread" });
declare function makeHandler(): () => unknown;
export const madeTool = tool({ name: "made", description: "Built by a call", execute: makeHandler() });
// A schema PermLang can't identify could be tool calls.
export function serveAny(server: Server, schema: object) {
  server.setRequestHandler(schema, async () => execSync("make"));
}`,
  // A namespace import of the schemas, and a schema computed at run time, which could be tool calls.
  schemaForms: `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as types from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
declare function schemaFor(method: string): object;
export function serveBroken(server: Server) {
  // A pull request's code may not compile: this must not stop the check.
  // @ts-expect-error -- no arguments
  server.setRequestHandler();
}
export function serveAll(server: Server) {
  server.setRequestHandler(types.CallToolRequestSchema, async () => execSync("make a"));
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(schemaFor("tools/call"), async () => execSync("make b"));
}`,
  // Handlers and definitions that can't be followed: each could be anything.
  unfollowable: `import { tool } from "@openai/agents";
import { run } from "untyped-runner";
declare const injectedHandler: (input: string) => string;
declare function pickHandler(): (input: string) => string;
let reassignable = pickHandler();
export const fromUntyped = tool({ name: "untyped", description: "From a package with no types", execute: run });
export const fromGlobal = tool({ name: "global", description: "Off an untyped global", execute: (globalThis as any).runTool });
export const fromDeclared = tool({ name: "declared", description: "A constant with no value here", execute: injectedHandler });
export const fromLet = tool({ name: "reassignable", description: "A variable that can change", execute: reassignable });
// A definition loaded at run time; and one cast to a type of your own named like a hosted tool.
interface HostedTool { name: string }
export const loaded = tool(JSON.parse(process.env.TOOL_JSON ?? "{}"));
export const disguised = tool(JSON.parse("{}") as HostedTool);`,
  // Constants that refer to each other don't make the check loop.
  loops: `import { tool } from "@openai/agents";
const first: any = second;
const second: any = first;
export const looped = tool({ name: "looped", description: "Loops", execute: first });
export const loopedDefinition = tool(first);`,
  // Found in re-verification: @perm-unsafe accepts code for annotations only. A model's input
  // still reaches the eval and require behind it.
  vouched: `import { tool } from "@openai/agents";
/** @perm-unsafe reason:"template compiler, trusted templates only" */
function render(t: string): unknown { return eval(t); }
/** @perm-unsafe reason:"plugin loader" */
function loadPlugin(p: string): unknown { return require(p); }
export const templateTool = tool({ name: "tpl", description: "Render a template", execute: async ({ t }: { t: string }) => String(render(t)) });
export const pluginTool = tool({ name: "plugin", description: "Load a plugin", execute: async ({ p }: { p: string }) => String(loadPlugin(p)) });`,
  // A tool a factory made, given in a tools record: registered once, where it's made, even when
  // its type is the definition's own.
  madeThenListed: `import { generateText, tool } from "ai";
import { execSync } from "node:child_process";
const listed = tool({ description: "List files", execute: async () => execSync("ls").toString() });
export async function ask(prompt: string) {
  return generateText({ prompt, tools: { listed } });
}`,
  // The schema is compared by symbol, so renaming the import doesn't hide the handler.
  renamedSchema: `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema as CallTool, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
export function serveRenamed(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallTool, async (request) => { spawn(request.params.name); });
}`,
};

let dir: string;
const run = (options: CheckOptions = {}): Report => checkTsConfig(path.join(dir, "tsconfig.json"), { strictness: "sketch", ...options });
const tool = (report: Report, name: string) => report.tools.find((t) => t.name === name)!;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "permlang-tools-"));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots }, include: ["*.ts"] }),
  );
  writeFileSync(path.join(dir, "frameworks.d.ts"), frameworks);
  for (const [name, code] of Object.entries(sources)) writeFileSync(path.join(dir, `${name}.ts`), code + "\n");
}, 60_000);

afterAll(() => removeTemporary(dir));

describe("tools given to AI models", () => {
  it("finds tool registrations across frameworks, with their names", () => {
    expect(run().tools.map((t) => `${t.framework} ${t.name}`).sort()).toEqual([
      "@langchain/core shell",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk dump_env",
      "@modelcontextprotocol/sdk ping",
      "@modelcontextprotocol/sdk read_file",
      "@modelcontextprotocol/sdk read_readme",
      "@modelcontextprotocol/sdk run_command",
      "@modelcontextprotocol/sdk save_note",
      "@openai/agents browse",
      "@openai/agents cleanup",
      "@openai/agents declared",
      "@openai/agents deploy",
      "@openai/agents disguised",
      "@openai/agents global",
      "@openai/agents held",
      "@openai/agents injected",
      "@openai/agents loaded",
      "@openai/agents looped",
      "@openai/agents loopedDefinition",
      "@openai/agents made",
      "@openai/agents plugin",
      "@openai/agents raw",
      "@openai/agents reassignable",
      "@openai/agents run",
      "@openai/agents spread",
      "@openai/agents tool",
      "@openai/agents tpl",
      "@openai/agents untyped",
      "ai deleteUser",
      "ai listed",
      "ai tool",
      "ai weather",
    ]);
  });

  it("doesn't take another package's tools option, or a tool list the app answers itself, for tools", () => {
    const files = run().tools.map((t) => path.basename(t.file));
    expect(files).not.toContain("notAnAiPackage.ts");
    expect(files).not.toContain("schemaOnly.ts");
  });

  it("takes MCP's last function argument as the handler, not a schema property named run", () => {
    expect(tool(run(), "run_command").reaches).toEqual(["exec"]);
  });

  it("follows shorthand { execute } to the function it names", () => {
    expect(tool(run(), "run").reaches).toEqual(["exec"]);
  });

  it("follows a library function given as the handler, and can't follow one passed in", () => {
    expect(tool(run(), "raw").reaches).toEqual(["exec"]);
    expect(tool(run(), "injected").reaches).toEqual(["unverifiable"]);
  });

  it("follows a definition held in a constant, and treats one it can't see as unverifiable", () => {
    const report = run();
    const inFile = Object.fromEntries(report.tools.filter((t) => t.file.endsWith("indirect.ts")).map((t) => [t.name, t.reaches.join(", ")]));
    expect(inFile).toEqual({ held: "exec", tool: "unverifiable", spread: "unverifiable", made: "unverifiable", "*": "exec" });
  });

  it("recognizes CallToolRequestSchema through a namespace import, and a schema it can't identify", () => {
    const handlers = run().tools.filter((t) => t.file.endsWith("schemaForms.ts"));
    expect(handlers.map((t) => `${t.name} ${t.line} ${t.reaches.join(",")}`)).toEqual(["* 11 exec", "* 13 exec"]);
  });

  it("treats a handler or definition it can't follow as unverifiable", () => {
    const inFile = Object.fromEntries(run().tools.filter((t) => t.file.endsWith("unfollowable.ts")).map((t) => [t.name, t.reaches.join(", ")]));
    expect(inFile).toEqual({
      untyped: "unverifiable",
      global: "unverifiable",
      declared: "unverifiable",
      reassignable: "unverifiable",
      loaded: "unverifiable",
      disguised: "unverifiable",
    });
  });

  it("follows a handler into code marked @perm-unsafe", () => {
    expect(tool(run(), "tpl").reaches).toEqual(["unverifiable"]);
    expect(tool(run(), "plugin").reaches).toEqual(["unverifiable"]);
    // The functions that register them aren't failed for it: @perm-unsafe still vouches for that.
    expect(run({ strictness: "development" }).diagnostics.filter((d) => d.file.endsWith("vouched.ts") && d.code === "PERM004")).toEqual([]);
  });

  it("registers a tool a factory made once, where it's made, when it's given in a collection", () => {
    expect(run().tools.filter((t) => t.file.endsWith("madeThenListed.ts")).map((t) => `${t.name} ${t.line}: ${t.reaches.join(", ")}`)).toEqual(["listed 3: exec"]);
  });

  it("doesn't loop on constants that refer to each other", () => {
    const inFile = Object.fromEntries(run().tools.filter((t) => t.file.endsWith("loops.ts")).map((t) => [t.name, t.reaches.join(", ")]));
    expect(inFile).toEqual({ looped: "unverifiable", loopedDefinition: "unverifiable" });
  });

  it("skips a property named like a handler whose value isn't a function", () => {
    expect(tool(run(), "deploy").reaches).toEqual(["exec"]);
  });

  it("recognizes a renamed CallToolRequestSchema, and not other request handlers", () => {
    const handlers = run().tools.filter((t) => t.name === "*" && t.file.endsWith("renamedSchema.ts"));
    expect(handlers.map((t) => `${t.line} ${t.reaches.join(",")}`)).toEqual(["6 exec"]);
  });

  it("warns about tools that read whatever file, table, or variable the model names", () => {
    const warned = run().diagnostics.filter((d) => d.code === "PERM008").map((d) => `${d.capability}: ${d.message}`);
    expect(warned).toContain("read_file: tool read_file (@modelcontextprotocol/sdk) can be called by an AI model, and reaches fs.read.");
    expect(warned).toContain("dump_env: tool dump_env (@modelcontextprotocol/sdk) can be called by an AI model, and reaches env.");
    // A fixed file is what tools are for.
    expect(warned.map((w) => w.split(":")[0])).not.toContain("read_readme");
  });

  it("works out what each tool's handler can reach", () => {
    const report = run();
    expect(tool(report, "deleteUser").reaches).toEqual(["exec"]);
    expect(tool(report, "weather").reaches).toEqual(["net(api.weather.example)"]);
    expect(tool(report, "save_note").reaches).toEqual(["fs.write"]);
    expect(tool(report, "ping").reaches).toEqual([]);
    expect(tool(report, "*").reaches).toEqual(["exec"]);
    expect(tool(report, "cleanup").reaches).toEqual(["fs.write(./cache)"]);
    expect(tool(report, "browse").reaches).toEqual(["net"]);
    expect(tool(report, "shell").reaches).toEqual(["exec"]);
  });

  it("warns when a model can trigger something dangerous, at the registration", () => {
    const warnings = run().diagnostics.filter((d) => d.code === "PERM008");
    expect(warnings.map((d) => `${d.severity} ${path.basename(d.file)}:${d.line} ${d.capability}`).sort()).toEqual([
      "warning anyHost.ts:2 browse",
      "warning byLibrary.ts:3 raw",
      "warning byLibrary.ts:5 injected",
      "warning byReference.ts:6 cleanup",
      "warning indirect.ts:10 spread",
      "warning indirect.ts:12 made",
      "warning indirect.ts:15 *",
      "warning indirect.ts:5 held",
      "warning indirect.ts:7 tool",
      "warning langchain.ts:3 shell",
      "warning loops.ts:4 looped",
      "warning loops.ts:5 loopedDefinition",
      "warning lowlevel.ts:5 *",
      "warning madeThenListed.ts:3 listed",
      "warning mcp.ts:5 save_note",
      "warning mcpSchemaRun.ts:5 run_command",
      "warning mcpSchemaRun.ts:6 read_file",
      "warning mcpSchemaRun.ts:7 dump_env",
      "warning renamedSchema.ts:6 *",
      "warning schemaForms.ts:11 *",
      "warning schemaForms.ts:13 *",
      "warning shorthand.ts:6 run",
      "warning shorthand.ts:8 deploy",
      "warning unfollowable.ts:12 loaded",
      "warning unfollowable.ts:13 disguised",
      "warning unfollowable.ts:6 untyped",
      "warning unfollowable.ts:7 global",
      "warning unfollowable.ts:8 declared",
      "warning unfollowable.ts:9 reassignable",
      "warning vercel.ts:4 deleteUser",
      "warning vouched.ts:6 tpl",
      "warning vouched.ts:7 plugin",
    ]);
    const shell = warnings.find((d) => d.capability === "shell")!;
    expect(shell.message).toBe("tool shell (@langchain/core) can be called by an AI model, and reaches exec.");
  });

  it("doesn't warn about tools that only read from a known host, or do nothing", () => {
    const warned = run().diagnostics.filter((d) => d.code === "PERM008").map((d) => d.capability);
    expect(warned).not.toContain("weather");
    expect(warned).not.toContain("ping");
  });

  it("doesn't count declaring a tool as network access", () => {
    const report = run();
    // The `ai` adapter maps the SDK's functions to network access; `tool()` only describes a tool.
    const inFile = report.functions.filter((f) => f.file.endsWith("vercel.ts"));
    expect(inFile.flatMap((f) => f.actual).sort()).toEqual(["exec", "net(api.weather.example)"]);
    // ...and @ai-sdk/provider-utils, where it's declared, is a known package.
    expect(report.unmapped.map((u) => u.package)).not.toContain("@ai-sdk/provider-utils");
  });

  it("follows the tools policy", () => {
    expect(run({ strictness: "development", tools: "error" }).diagnostics.filter((d) => d.code === "PERM008").every((d) => d.severity === "error")).toBe(true);
    // "error" is asked for explicitly, so it fails at sketch too; the default stays a warning.
    const atSketch = (tools?: "error") => run({ strictness: "sketch", ...(tools ? { tools } : {}) }).diagnostics.filter((d) => d.code === "PERM008").map((d) => d.severity);
    expect(atSketch("error")).toEqual(Array(32).fill("error"));
    expect(atSketch()).toEqual(Array(32).fill("warning"));
    expect(run({ tools: "trust" }).diagnostics.filter((d) => d.code === "PERM008")).toEqual([]);
    // The tools are still listed.
    expect(run({ tools: "trust" }).tools).toHaveLength(36);
  });

  it("counts an MCP client's connection as network access, and a server talking to its client as none", () => {
    const report = run();
    expect(report.functions.find((f) => f.name === "connectRemote")!.actual).toEqual(["net(mcp.example.com)"]);
    expect(report.functions.find((f) => f.name === "start")!.actual).toEqual(["fs.write"]);
  });

  it("still charges the code that registers a tool with what the tool reaches", () => {
    expect(run().functions.find((f) => f.name === "start")!.actual).toContain("fs.write");
  });
});

// What a tools collection can hold, written every way PermLang tells apart. The stand-ins'
// generateText takes any object, so each form type-checks.
describe("entries of a tools collection", () => {
  const source = `import { generateText, tool } from "ai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { execSync } from "node:child_process";
type Definition = { description: string; execute: () => string };
type Listed = { name: string; invoke: () => Promise<string> };
function runCommand() {
  return execSync("make").toString();
}
declare function handlerKey(): string;
declare function declaredDefinition(): Definition;
declare const untyped: any;
class MyTool extends DynamicStructuredTool {}
class CommandRunner {
  execute() {
    return execSync("make").toString();
  }
}
const concise = () => ({ description: "concise", execute: () => execSync("ls").toString() });
const helpers = {
  make() {
    return { description: "method", execute: () => execSync("ls").toString() };
  },
};
const expression = function () {
  return { description: "expression", execute: () => execSync("ls").toString() };
};
function nothing(): void {
  return;
}
function either(flag: boolean): Definition | { description: string; run: () => string } {
  return flag ? { description: "a", execute: () => "" } : { description: "b", run: () => "" };
}
function tagged(): Definition & { tag: string } {
  return { description: "tagged", execute: () => "", tag: "t" };
}
function shellFrom() {
  return { name: "shell", shell: { run: async () => "" } };
}
const loopA: any = loopB;
const loopB: any = loopA;
export async function ask(prompt: string, mine: MyTool, theirs: DynamicStructuredTool) {
  return generateText({
    prompt,
    tools: [
      runCommand,
      async () => execSync("pwd").toString(),
      ,
      new MyTool({ name: "mine", description: "Mine", schema: {}, func: async () => "" }),
      mine,
      theirs,
      nothing(),
      declaredDefinition(),
      concise(),
      helpers.make(),
      expression(),
      either(true),
      tagged(),
      shellFrom(),
      loopA,
      untyped.build(),
      new CommandRunner(),
    ],
  });
}
export const fnTools = generateText({ prompt: "hi", tools: runCommand });
export async function askRecord(prompt: string) {
  return generateText({
    prompt,
    tools: {
      computed: { description: "Computed handler key", [handlerKey()]: async () => execSync("ls").toString() },
      schema: { description: "Not a handler", [handlerKey()]: "settings" },
    },
  });
}
const spreadA: any = { ...spreadB };
const spreadB: any = { ...spreadA };
export const loopedSpread = tool({ ...spreadA, name: "loopedSpread" });
const optionsA: any = { ...optionsB };
const optionsB: any = { ...optionsA };
export const loopedOptions = generateText({ ...optionsA, prompt: "hi" });
const bracketed: Record<string, any> = {};
bracketed["named"] = { description: "Named", execute: async () => execSync("ls").toString() };
bracketed[handlerKey()] = { description: "Unnamed", execute: async () => execSync("pwd").toString() };
bracketed.named.execute = runCommand;
void bracketed.named;
bracketed.named.execute();
export const bracketedTools = generateText({ prompt: "hi", tools: bracketed });
const more: Listed[] = [];
const extra: Listed[] = [{ name: "extra", invoke: async () => execSync("ls").toString() }];
more.push(...extra);
more.splice(0, 0, { name: "spliced", invoke: async () => "" });
more.includes(extra[0]!);
export const moreTools = generateText({ prompt: "hi", tools: more });
`;
  let report: Report;
  const listed = () => report.tools.map((t) => `${t.name} ${t.line}: ${t.reaches.join(", ") || "nothing"}`);

  beforeAll(() => {
    const project = mkdtempSync(path.join(tmpdir(), "permlang-tools-entries-"));
    writeFileSync(
      path.join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots }, include: ["*.ts"] }),
    );
    writeFileSync(path.join(project, "frameworks.d.ts"), frameworks);
    writeFileSync(path.join(project, "edges.ts"), source);
    report = checkTsConfig(path.join(project, "tsconfig.json"), { strictness: "sketch" });
    removeTemporary(project);
  }, 60_000);

  it("follows a function given as the tool, and skips holes and tools made or typed by the framework", () => {
    // Named by the function, else "tool".
    expect(listed()).toContain("runCommand 45: exec");
    expect(listed()).toContain("tool 46: exec");
    // A hole; your subclass of the framework's tool class, registered once where it's made; a
    // value typed as it, or as the framework's own class; a function that returns nothing.
    expect(listed()).toContain("MyTool 48: nothing");
    expect(listed().filter((t) => / (47|49|50|51):/.test(t))).toEqual([]);
  });

  it("can't follow a plain object a helper of yours builds, or a value it can't see", () => {
    // A declared function, an arrow function, a method, a function expression; a union, an
    // intersection, a built-in tool's object; constants in a loop; any; your own class.
    for (const line of [52, 53, 54, 55, 56, 57, 58, 59, 60, 61]) expect(listed()).toContain(`* ${line}: unverifiable`);
  });

  it("reads a handler under a computed key, and skips a schema under one", () => {
    expect(listed()).toContain("computed 70: exec");
    expect(listed().filter((t) => t.includes(" 71:"))).toEqual([]);
  });

  it("stops in loops of spreads, and reports what it can't list", () => {
    // A definition spread from constants that spread each other: no handler to follow.
    expect(listed()).toContain("loopedSpread 77: unverifiable");
    // Options spread from constants that spread each other could set any tools.
    expect(listed()).toContain("* 79: unverifiable");
    // A function given as the whole collection.
    expect(listed()).toContain("* 65: unverifiable");
  });

  it("follows what's added to a constant collection later, and reports changes it can't list", () => {
    // `tools["named"] = ...`, and a computed key, named by the definition, else "tool".
    expect(listed()).toContain("named 82: exec");
    expect(listed()).toContain("tool 83: exec");
    // Changing an entry (`tools.named.execute = ...`); reading or calling one changes nothing.
    expect(listed()).toContain("* 84: unverifiable");
    expect(listed().filter((t) => / (85|86):/.test(t))).toEqual([]);
    // `push(...more)` is listed; `splice` can't be; `includes` changes nothing.
    expect(listed()).toContain("extra 89: exec");
    expect(listed()).toContain("* 91: unverifiable");
    expect(listed().filter((t) => t.includes(" 92:"))).toEqual([]);
    // Nothing else.
    expect(listed()).toHaveLength(22);
  });
});

// The same frameworks, with their packages laid out as published (test/ai-packages.ts):
// re-exports from sibling packages, minified chunk names, provider tools, and classes.
describe("tools registered with frameworks as they're published", () => {
  let project: string;
  const sources: Record<string, string> = {
    // @openai/agents re-exports tool() from @openai/agents-core.
    agents: `import { Agent, applyPatchTool, computerTool, shellTool, tool, webSearchTool, type Computer, type Editor } from "@openai/agents";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
export const shell = tool({ name: "shell", description: "Run a command", parameters: {}, execute: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() });
export const localShell = shellTool({
  shell: {
    async run(action) {
      return { output: action.commands.map((c) => execSync(c).toString()) };
    },
  },
});
class WorkspaceEditor implements Editor {
  async createFile(path: string, diff: string) { writeFileSync("./workspace/" + path, diff); }
  async updateFile(path: string, diff: string) { writeFileSync("./workspace/" + path, diff); }
  async deleteFile(path: string) { rmSync("./workspace/" + path); }
}
export const patcher = applyPatchTool({ editor: new WorkspaceEditor() });
class Desktop implements Computer {
  environment = "ubuntu" as const;
  dimensions: [number, number] = [1024, 768];
  async screenshot() { return execSync("import -window root png:-").toString("base64"); }
  async click(x: number, y: number) { execSync("xdotool mousemove " + x + " " + y + " click 1"); }
  async type(text: string) { execSync("xdotool type " + text); }
}
// The computer is built when a run starts: what the framework calls is the built object's methods.
export const desktop = computerTool({ computer: async () => new Desktop() });
// Run by OpenAI, not here.
export const hostedShell = shellTool({ environment: { type: "container_auto" } });
export const search = webSearchTool();
export const agent = new Agent({ name: "helper", tools: [shell, localShell, patcher, hostedShell, search] });`,
    // The MCP SDK's version 2 server package: McpServer comes from a minified chunk.
    mcpv2: `import { McpServer } from "@modelcontextprotocol/server";
import { execSync, spawn } from "node:child_process";
export function start() {
  const server = new McpServer({ name: "ops", version: "1.0.0" });
  server.registerTool("run", { description: "Run a command" }, async ({ cmd }: { cmd: string }) => ({ content: [{ type: "text" as const, text: execSync(cmd).toString() }] }));
  server.server.setRequestHandler("tools/list", async () => ({ tools: [] }));
  server.server.setRequestHandler("tools/call", async (request) => { spawn(request.params.name); return { content: [] }; });
  return server;
}`,
    // Plain objects in a tools option, inline or through a constant.
    plain: `import { ToolLoopAgent, generateText, tool } from "ai";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const weather = tool({ description: "Weather", inputSchema: {}, execute: async () => fetch("https://api.weather.example/today") });
export async function chat(prompt: string) {
  return generateText({
    prompt,
    tools: { shell: { description: "Run a command", inputSchema: {}, execute: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() }, weather },
  });
}
const notesTools = {
  readNotes: { description: "Read the notes", inputSchema: {}, execute: async () => readFileSync("./notes.md", "utf8") },
};
export const notesAgent = new ToolLoopAgent({ tools: notesTools });
// Your own agent class isn't a tool.
class NotesAgent extends ToolLoopAgent {}
export const second = new NotesAgent({ tools: notesTools });`,
    // Provider tools: Claude's bash tool with an execute runs it here; without one, the AI SDK
    // runs it in whatever sandbox the call is given; code execution runs at Anthropic.
    provider: `import { anthropic } from "@ai-sdk/anthropic";
import { execSync } from "node:child_process";
export const bash = anthropic.tools.bash_20250124({ execute: async ({ command }) => execSync(command).toString() });
export const sandboxBash = anthropic.tools.bash_20250124();
export const codeExecution = anthropic.tools.codeExecution_20250522();`,
    llama: `import { FunctionTool, tool } from "llamaindex";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
export const shellTool = FunctionTool.from(({ cmd }: { cmd: string }) => execSync(cmd).toString(), { name: "shell", description: "Run a command" });
export const readTool = tool(({ path }: { path: string }) => readFileSync(path, "utf8"), { name: "read_file", description: "Read a file" });
export const configTool = FunctionTool.from({ name: "config", description: "Read the config", parameters: {}, execute: () => readFileSync("./config.json", "utf8") });`,
    // OpenAI Agents' built-in tools given objects in other ways.
    agentsMore: `import { applyPatchTool, computerTool, fileSearchTool, shellTool, type Computer } from "@openai/agents";
import { RemoteEditor, connectDesktop, sandboxShell } from "agent-sandbox";
import { connect } from "legacy-desktop";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
async function runCommands(action: { commands: string[] }) {
  return { output: action.commands.map((c) => execSync(c).toString()) };
}
function typeText(text: string) {
  return Promise.resolve(void writeFileSync("./typed", text));
}
// The object's run is a function declared elsewhere.
export const byReference = shellTool({ shell: { run: runCommands } });
// A library's objects, or one spread from it: what runs can't be seen.
export const library = shellTool({ shell: sandboxShell });
export const spread = shellTool({ shell: { ...sandboxShell } });
export const libraryEditor = applyPatchTool({ editor: new RemoteEditor() });
// A computer written inline: its functions run, its settings don't.
export const browser = computerTool({
  computer: {
    environment: "browser",
    dimensions: [1024, 768],
    async screenshot() {
      return execSync("screenshot").toString();
    },
    click: async () => void writeFileSync("./clicks", "1"),
    type: typeText,
  },
});
// Computers built when a run starts: by a provider's create, by a factory typed as the library's
// interface, or by an untyped one.
class Kiosk implements Computer {
  environment = "browser" as const;
  dimensions: [number, number] = [800, 600];
  async screenshot() { return ""; }
  async click() {}
  async type(text: string) { writeFileSync("./kiosk", text); }
}
export const kiosk = computerTool({ computer: { create: () => new Kiosk() } });
export const remote = computerTool({ computer: async (): Promise<Computer> => connectDesktop() });
export const legacy = computerTool({ computer: () => connect() });
// Searches files stored at OpenAI.
export const files = fileSearchTool("vs_123");`,
    // Found in re-verification: a hosted tool runs at OpenAI, but callbacks it's given run here.
    hosted: `import { hostedMcpTool, webSearchTool } from "@openai/agents";
import { execSync } from "node:child_process";
export const approved = hostedMcpTool({
  serverLabel: "docs",
  serverUrl: "https://mcp.example",
  requireApproval: "always",
  onApproval: async (_context, item) => {
    execSync("notify-send " + item.toolName);
    return { approve: true };
  },
});
async function approveAll() {
  return { approve: true };
}
export const byName = hostedMcpTool({ serverLabel: "docs", requireApproval: "always", onApproval: approveAll });
export const noCallback = hostedMcpTool({ serverLabel: "docs", requireApproval: "never" });
// Options from elsewhere could carry a callback; a web search's can't.
declare const config: Parameters<typeof hostedMcpTool>[0];
export const fromConfig = hostedMcpTool(config);
export function search(options: Parameters<typeof webSearchTool>[0]) {
  return webSearchTool(options);
}
// A callback in options spread in from a constant; options parsed at run time.
const approval = {
  requireApproval: "always" as const,
  onApproval: async () => {
    execSync("notify-send approval");
    return { approve: true };
  },
};
export const spreadApproval = hostedMcpTool({ serverLabel: "docs", ...approval });
export const parsedConfig = hostedMcpTool(JSON.parse("{}"));`,
    // Found in re-verification: frameworks that weren't recognized. OpenAI's SDK runs the
    // functions given to chat.completions.runTools; its other calls only send schemas.
    openai: `import OpenAI from "openai";
import { zodFunction } from "openai/helpers/zod";
import { ParsingToolFunction } from "openai/lib/RunnableFunction";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
declare const pathSchema: { parse(input: unknown): { path: string } };
const client = new OpenAI();
export async function inline() {
  return client.chat.completions.runTools({
    model: "gpt-x",
    messages: [],
    tools: [{ type: "function", function: { name: "oa_shell", description: "Run a command", parameters: {}, parse: JSON.parse, function: (a: { cmd: string }) => execSync(a.cmd).toString() } }],
  }).finalContent();
}
const readTool = zodFunction({ name: "read_file", parameters: pathSchema, function: ({ path }) => readFileSync(path, "utf8") });
export async function withZod() {
  return client.chat.completions.runTools({ model: "gpt-x", messages: [], tools: [readTool] }).finalContent();
}
// Making a tool sends nothing to OpenAI: running the model does.
export function makeListTool() {
  return zodFunction({ name: "list_files", parameters: pathSchema, function: ({ path }) => readFileSync(path, "utf8") });
}
export const parsing = new ParsingToolFunction({ name: "parsed", description: "Run", parameters: {}, parse: JSON.parse, function: (a: { cmd: string }) => execSync(a.cmd).toString() });
export async function schemaOnly() {
  return client.chat.completions.create({ model: "gpt-x", messages: [], tools: [{ type: "function", function: { name: "weather", parameters: {} } }] });
}
type CreateTools = Parameters<typeof client.chat.completions.create>[0]["tools"];
export async function schemaPassedIn(tools: CreateTools) {
  return client.chat.completions.create({ model: "gpt-x", messages: [], tools });
}
export async function paramsPassedIn(params: Parameters<typeof client.chat.completions.create>[0]) {
  return client.chat.completions.create(params);
}
function schemaOf(name: string) {
  return { type: "function" as const, function: { name, parameters: {} } };
}
export async function schemaFromHelper() {
  return client.chat.completions.create({ model: "gpt-x", messages: [], tools: [schemaOf("weather")] });
}
export async function responses() {
  return client.responses.create({ model: "gpt-x", input: "hi", tools: [{ type: "function", name: "weather", parameters: {}, strict: true }, { type: "web_search" }] });
}
// A runTools tool a helper of yours builds: it can't be followed.
function runnable(cmd: string) {
  return { type: "function" as const, function: { name: cmd, description: cmd, parameters: {}, function: () => execSync(cmd).toString() } };
}
export async function withHelper() {
  return client.chat.completions.runTools({ model: "gpt-x", messages: [], tools: [runnable("ls")] }).finalContent();
}
// A session turn of the beta Agents API runs the handlers in toolHandlers.
function runShell(args: Record<string, unknown>) {
  return { output: execSync(String(args.cmd)).toString() };
}
export function agentTurn(sessionID: string) {
  return client.beta.agents.sessions.stream(sessionID, { input: "hi", toolHandlers: { lookup: async (args) => ({ text: readFileSync(String(args.path), "utf8") }), shell: runShell } });
}
export function agentTurnWith(sessionID: string, handlers: Record<string, (args: Record<string, unknown>) => object>) {
  return client.beta.agents.sessions.stream(sessionID, { input: "hi", toolHandlers: handlers });
}`,
    fastmcp: `import { FastMCP } from "fastmcp";
import { execSync } from "node:child_process";
const server = new FastMCP({ name: "ops", version: "1.0.0" });
server.addTool({ name: "fm_shell", execute: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() });
server.addTools([{ name: "fm_list", execute: async () => execSync("ls").toString() }]);`,
    genkit: `import { dynamicTool, genkit, tool } from "genkit";
import { execSync } from "node:child_process";
const ai = genkit({});
export const gk = ai.defineTool({ name: "gk_shell", description: "Run a command" }, async ({ cmd }: { cmd: string }) => execSync(cmd).toString());
export const gkDynamic = ai.dynamicTool({ name: "gk_dynamic", description: "List files" }, async () => execSync("ls").toString());
export const gkTool = tool({ name: "gk_tool", description: "Run a command" }, async ({ cmd }: { cmd: string }) => execSync(cmd).toString());
// No function: the app answers the model itself, wherever it does.
export const gkAsk = dynamicTool({ name: "gk_ask", description: "Ask the user" });
// Tools given by value or by name are registered where they're defined.
export async function ask(prompt: string) {
  return ai.generate({ prompt, tools: [gk, "gk_tool"] });
}
// A list of names, passed in: names can't be a tool that runs.
export async function askByName(prompt: string, names: string[]) {
  return ai.generate({ prompt, tools: names });
}`,
    // Found in re-verification: plain-object tools given in forms that were missed. Collections
    // that can't be listed could hold any tool.
    collections: `import { ToolLoopAgent, generateText, tool } from "ai";
import { Agent, type FunctionTool } from "@openai/agents";
import { execSync } from "node:child_process";
export async function quoted(prompt: string) {
  return generateText({ prompt, tools: { sh: { description: "Run", inputSchema: {}, "execute": async ({ cmd }: { cmd: string }) => execSync(cmd).toString() } } });
}
const K = "execute";
export async function computed(prompt: string) {
  return generateText({ prompt, tools: { cs: { description: "Run", inputSchema: {}, [K]: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() } } });
}
export const quotedTool = tool({ description: "Run", inputSchema: {}, "execute": async ({ cmd }: { cmd: string }) => execSync(cmd).toString() } as any);
const filled: Record<string, any> = {};
filled.later = { description: "Run", inputSchema: {}, execute: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() };
export const filledAgent = new ToolLoopAgent({ tools: filled });
const options = { tools: { spreadIn: { description: "Run", inputSchema: {}, execute: async ({ cmd }: { cmd: string }) => execSync(cmd).toString() } } };
export async function spreadOptions(prompt: string) {
  return generateText({ ...options, prompt });
}
const onlySpread: FunctionTool[] = [{ type: "function", name: "spreadList", invoke: async (input: string) => execSync(input).toString() } as any];
export const spreadAgent = new Agent({ name: "s", tools: [...onlySpread] });
const names = ["ls", "pwd"];
export const fromEntries = new ToolLoopAgent({ tools: Object.fromEntries(names.map((n) => [n, { description: n, inputSchema: {}, execute: async () => execSync(n).toString() }])) });
function shellDefinition(cmd: string) {
  return { description: cmd, inputSchema: {}, execute: async () => execSync(cmd).toString() };
}
export async function fromHelper(prompt: string) {
  return generateText({ prompt, tools: { helped: shellDefinition("ls") } });
}
function baseTools() {
  return { base: shellDefinition("ls") };
}
export async function spreadCall(prompt: string) {
  return generateText({ prompt, tools: { ...baseTools() } });
}
let reassignable = { mutable: shellDefinition("ls") };
export async function fromLet(prompt: string) {
  return generateText({ prompt, tools: reassignable });
}
export async function optionsPassedIn(options: Parameters<typeof generateText>[0]) {
  return generateText({ ...options, prompt: "hi" });
}
// A helper that returns a framework's tool: the tool is registered where it's made.
function makeTool(cmd: string) {
  return tool({ description: cmd, inputSchema: {}, execute: async () => execSync(cmd).toString() });
}
export async function viaFactory(prompt: string) {
  return generateText({ prompt, tools: { made: makeTool("ls") } });
}
// Changed after it's created: by Object.assign (can't be listed), and push (can).
const merged: Record<string, any> = {};
Object.assign(merged, baseTools());
export const mergedAgent = new ToolLoopAgent({ tools: merged });
const list: any[] = [];
list.push({ name: "pushed", invoke: async () => execSync("ls").toString() });
export const listAgent = new Agent({ name: "l", tools: list });
// Calling an entry changes nothing.
const used = { safe: { description: "The time", inputSchema: {}, execute: async () => Date.now() } };
export const usedAgent = new ToolLoopAgent({ tools: used });
export async function callDirectly() {
  return used.safe.execute();
}`,
    // A library's prebuilt tool runs code PermLang can't see.
    prebuilt: `import { Calculator } from "@langchain/community/tools/calculator";
export const calculator = new Calculator();`,
    // Your own LangChain tool classes: StructuredTool runs _call.
    langchain: `import { DynamicStructuredTool, StructuredTool } from "@langchain/core/tools";
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
export class ShellTool extends StructuredTool {
  name = "shell";
  description = "Run a command";
  schema = {};
  protected async _call({ cmd }: { cmd: string }) {
    exec(cmd);
    return "ok";
  }
}
class NotesTool extends DynamicStructuredTool {
  constructor() {
    super({ name: "save_note", description: "Save a note", schema: {}, func: async ({ text }: { text: string }) => writeFileSync("./notes.md", text) });
  }
}
// A class expression held in a constant.
const GrepTool = class extends StructuredTool {
  name = "grep";
  description = "Search files";
  schema = {};
  protected async _call({ pattern }: { pattern: string }) {
    exec("grep -r " + pattern);
    return "ok";
  }
};
// Found in re-verification: what runs is any method the framework calls, not only _call.
class InvokeOverride extends StructuredTool {
  name = "inv";
  description = "Overrides invoke";
  schema = {};
  protected async _call() {
    return "ok";
  }
  override async invoke(input: unknown) {
    writeFileSync("/etc/x", String(input));
    return "done";
  }
}
export const tools = [new ShellTool(), new NotesTool(), new GrepTool(), new InvokeOverride()];`,
    // Tools option forms: spreads, a shorthand, a list, and a record passed in from elsewhere.
    options: `import { generateText, tool, type ToolSet } from "ai";
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const shared = { lookup: { description: "Look up a file", inputSchema: {}, execute: async ({ path }: { path: string }) => readFileSync(path, "utf8") } };
export async function withSpread(prompt: string) {
  const tools = { ...shared, now: tool({ description: "The time", inputSchema: {}, execute: async () => Date.now() }) };
  return generateText({ prompt, tools });
}
export async function passedIn(prompt: string, tools: ToolSet) {
  return generateText({ prompt, tools });
}
const RUN_NAME = "run_script";
export async function runner(client: Anthropic, script: string) {
  return client.beta.messages.toolRunner({
    tools: [
      { name: RUN_NAME, input_schema: {}, run: async () => execSync(script).toString() },
      { name: \`check_\${script}\`, input_schema: {}, run: async () => "ok" },
    ],
  });
}
// Records spread into each other.
const left: any = { ...right };
const right: any = { ...left };
export const looping = generateText({ prompt: "hi", tools: left });`,
  };
  const check = (options: CheckOptions = {}) => checkTsConfig(path.join(project, "tsconfig.json"), { strictness: "sketch", ...options });
  const reaches = (report: Report, file: string) =>
    Object.fromEntries(report.tools.filter((t) => path.basename(t.file) === `${file}.ts`).map((t) => [t.name, t.reaches.join(", ") || "nothing"]));

  beforeAll(() => {
    project = mkdtempSync(path.join(tmpdir(), "permlang-tools-published-"));
    for (const [file, text] of Object.entries(publishedPackages)) {
      mkdirSync(path.dirname(path.join(project, "node_modules", file)), { recursive: true });
      writeFileSync(path.join(project, "node_modules", file), text);
    }
    // Packages of the app's own choosing: a sandbox library, and one with no types.
    const extra: Record<string, string> = {
      "agent-sandbox/package.json": JSON.stringify({ name: "agent-sandbox", version: "1.0.0", types: "./index.d.ts" }),
      "agent-sandbox/index.d.ts": `import type { Computer, Editor, Shell } from "@openai/agents";
export declare const sandboxShell: Shell;
export declare class RemoteEditor implements Editor {
  createFile(path: string, diff: string): Promise<void>;
  updateFile(path: string, diff: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
}
export declare function connectDesktop(): Promise<Computer>;
`,
      "legacy-desktop/package.json": JSON.stringify({ name: "legacy-desktop", version: "1.0.0", main: "./index.js" }),
      "legacy-desktop/index.js": "exports.connect = () => ({});\n",
      "@anthropic-ai/sdk/package.json": JSON.stringify({ name: "@anthropic-ai/sdk", version: "0.0.0-test", types: "./index.d.ts" }),
      "@anthropic-ai/sdk/index.d.ts": `type RunnableTool = { name: string; input_schema: object; run: (input: any) => unknown };
export default class Anthropic {
  beta: { messages: { toolRunner(options: { tools: RunnableTool[] }): Promise<unknown> } };
}
`,
    };
    for (const [file, text] of Object.entries(extra)) {
      mkdirSync(path.dirname(path.join(project, "node_modules", file)), { recursive: true });
      writeFileSync(path.join(project, "node_modules", file), text);
    }
    writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "app", type: "module" }));
    writeFileSync(
      path.join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: ["node"], typeRoots }, include: ["*.ts"] }),
    );
    for (const [name, code] of Object.entries(sources)) writeFileSync(path.join(project, `${name}.ts`), code + "\n");
  }, 60_000);

  afterAll(() => removeTemporary(project));

  it("finds OpenAI Agents tools through @openai/agents' re-exports, including built-in tools that run here", () => {
    expect(reaches(check(), "agents")).toEqual({
      shell: "exec",
      localShell: "exec",
      patcher: "fs.write",
      desktop: "exec",
      hostedShell: "nothing",
      search: "nothing",
    });
    expect(check().tools.find((t) => t.name === "shell" && t.file.endsWith("agents.ts"))!.framework).toBe("@openai/agents");
  });

  it("finds tools registered with the MCP SDK's version 2 server, and its tools/call handler", () => {
    expect(reaches(check(), "mcpv2")).toEqual({ run: "exec", "*": "exec" });
    // The MCP adapter covers it: a server makes no connections of its own.
    expect(check().unmapped.map((u) => u.package)).not.toContain("@modelcontextprotocol/server");
    expect(check().functions.find((f) => f.name === "start")!.actual).toEqual(["exec"]);
  });

  it("finds plain-object tools passed to the AI SDK, inline or through a constant", () => {
    expect(reaches(check(), "plain")).toEqual({ weather: "net(api.weather.example)", shell: "exec", readNotes: "fs.read(./notes.md)" });
    // Each is listed once: a tool() value in a tools object, and a constant two agents share.
    expect(check().tools.filter((t) => t.file.endsWith("plain.ts")).map((t) => t.name).sort()).toEqual(["readNotes", "shell", "weather"]);
  });

  it("finds provider tools, and treats one the AI SDK runs in a sandbox as unverifiable", () => {
    expect(reaches(check(), "provider")).toEqual({ bash: "exec", sandboxBash: "unverifiable", codeExecution: "nothing" });
  });

  it("finds LlamaIndex tools made with FunctionTool.from and tool()", () => {
    expect(reaches(check(), "llama")).toEqual({ shell: "exec", read_file: "fs.read", config: "fs.read(./config.json)" });
  });

  it("follows your own LangChain tool classes to what they run", () => {
    // Named by their name field, else by the class.
    expect(reaches(check(), "langchain")).toEqual({ shell: "exec", NotesTool: "fs.write(./notes.md)", grep: "exec", inv: "fs.write(/etc/x)" });
  });

  it("follows the callbacks given to a tool that runs at the provider", () => {
    expect(reaches(check(), "hosted")).toEqual({
      approved: "exec",
      byName: "nothing",
      noCallback: "nothing",
      fromConfig: "unverifiable",
      tool: "nothing",
      // A callback spread in from a constant; options parsed at run time, which could hold one.
      spreadApproval: "exec",
      parsedConfig: "unverifiable",
    });
  });

  it("finds the OpenAI SDK's tools that runTools runs, and not schemas its other calls send", () => {
    expect(reaches(check(), "openai")).toEqual({
      oa_shell: "exec",
      read_file: "fs.read",
      list_files: "fs.read",
      parsed: "exec",
      // The beta Agents API's toolHandlers: written in the call, and a record passed in.
      lookup: "fs.read",
      shell: "exec",
      "*": "unverifiable",
    });
    // A runTools tool built by a helper of yours, and the record of handlers passed in.
    expect(check().tools.filter((t) => t.file.endsWith("openai.ts") && t.name === "*").map((t) => t.line)).toEqual([48, 58]);
    // The helpers that make a tool only build an object, as the AI SDK's tool() does.
    expect(check().functions.find((f) => f.name === "makeListTool")!.actual).toEqual(["fs.read"]);
  });

  it("finds FastMCP's and Genkit's tools", () => {
    expect(reaches(check(), "fastmcp")).toEqual({ fm_shell: "exec", fm_list: "exec" });
    expect(reaches(check(), "genkit")).toEqual({ gk_shell: "exec", gk_dynamic: "exec", gk_tool: "exec", gk_ask: "unverifiable" });
    expect(check().tools.filter((t) => t.file.endsWith("genkit.ts")).map((t) => t.framework)).toEqual(Array(4).fill("genkit"));
  });

  it("lists plain-object tools however they're given, and reports collections it can't list", () => {
    const inFile = check().tools.filter((t) => t.file.endsWith("collections.ts")).map((t) => `${t.name} ${t.line}: ${t.reaches.join(", ") || "nothing"}`);
    expect(inFile.sort()).toEqual([
      // Object.fromEntries(...), { ...baseTools() }, a let, and options passed in.
      "* 22: unverifiable",
      "* 33: unverifiable",
      "* 37: unverifiable",
      "* 40: unverifiable",
      // Object.assign(merged, ...).
      "* 51: unverifiable",
      "cs 9: exec",
      "helped 27: unverifiable",
      "later 13: exec",
      "pushed 54: exec",
      "quotedTool 11: exec",
      "safe 57: nothing",
      "sh 5: exec",
      "spreadIn 15: exec",
      "spreadList 19: exec",
      "tool 44: exec",
    ]);
    const unlisted = check().diagnostics.find((d) => d.code === "PERM008" && d.file.endsWith("collections.ts") && d.line === 22)!;
    expect(unlisted.message).toBe("tools given here (ai) can't all be listed, so what an AI model can trigger through them can't be checked.");
    expect(unlisted.fix).toBe(
      "write the tools out in the call, or in a constant it uses, so PermLang can follow each one; a tool a framework function makes (tool(...)) is followed where it's made.",
    );
  });

  it("treats a library's prebuilt tool class as unverifiable", () => {
    expect(reaches(check(), "prebuilt")).toEqual({ calculator: "unverifiable" });
  });

  it("follows built-in tools' objects and factories, and can't see into a library's", () => {
    expect(reaches(check(), "agentsMore")).toEqual({
      byReference: "exec",
      library: "unverifiable",
      spread: "unverifiable",
      libraryEditor: "unverifiable",
      browser: "exec, fs.write(./clicks), fs.write(./typed)",
      kiosk: "fs.write(./kiosk)",
      remote: "unverifiable",
      legacy: "unverifiable",
      files: "nothing",
    });
  });

  it("finds tools in tools options written with spreads and lists, and can't follow ones passed in", () => {
    // A ToolSet passed in, and records spread into each other in a loop, could hold any tool.
    expect(reaches(check(), "options")).toEqual({ lookup: "fs.read", now: "nothing", run_script: "exec", tool: "nothing", "*": "unverifiable" });
    expect(check().tools.filter((t) => t.file.endsWith("options.ts") && t.name === "*").map((t) => t.line)).toEqual([11, 25]);
  });

  it("warns only about the ones a model shouldn't trigger unchecked", () => {
    const warned = check().diagnostics.filter((d) => d.code === "PERM008").map((d) => `${path.basename(d.file)} ${d.capability}`);
    expect(warned.sort()).toEqual([
      "agents.ts desktop",
      "agents.ts localShell",
      "agents.ts patcher",
      "agents.ts shell",
      "agentsMore.ts browser",
      "agentsMore.ts byReference",
      "agentsMore.ts kiosk",
      "agentsMore.ts legacy",
      "agentsMore.ts library",
      "agentsMore.ts libraryEditor",
      "agentsMore.ts remote",
      "agentsMore.ts spread",
      "collections.ts *",
      "collections.ts *",
      "collections.ts *",
      "collections.ts *",
      "collections.ts *",
      "collections.ts cs",
      "collections.ts helped",
      "collections.ts later",
      "collections.ts pushed",
      "collections.ts quotedTool",
      "collections.ts sh",
      "collections.ts spreadIn",
      "collections.ts spreadList",
      "collections.ts tool",
      "fastmcp.ts fm_list",
      "fastmcp.ts fm_shell",
      "genkit.ts gk_ask",
      "genkit.ts gk_dynamic",
      "genkit.ts gk_shell",
      "genkit.ts gk_tool",
      "hosted.ts approved",
      "hosted.ts fromConfig",
      "hosted.ts parsedConfig",
      "hosted.ts spreadApproval",
      "langchain.ts NotesTool",
      "langchain.ts grep",
      "langchain.ts inv",
      "langchain.ts shell",
      "llama.ts read_file",
      "llama.ts shell",
      "mcpv2.ts *",
      "mcpv2.ts run",
      "openai.ts *",
      "openai.ts *",
      "openai.ts list_files",
      "openai.ts lookup",
      "openai.ts oa_shell",
      "openai.ts parsed",
      "openai.ts read_file",
      "openai.ts shell",
      "options.ts *",
      "options.ts *",
      "options.ts lookup",
      "options.ts run_script",
      "plain.ts shell",
      "prebuilt.ts calculator",
      "provider.ts bash",
      "provider.ts sandboxBash",
    ]);
  });
});
