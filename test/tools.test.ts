// Tools given to AI models. A function registered as a tool can be called by whoever
// controls the model's input, so prompt injection can trigger anything the tool reaches.
// PermLang finds tool registrations, works out what each handler reaches, and warns when
// a model can trigger something dangerous.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkTsConfig, type CheckOptions, type Report } from "../src/check.js";

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
declare module "task-runner" {
  export function tool(definition: { execute: () => unknown }): void;
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
  notAnAiPackage: `import { tool } from "task-runner";
import { execSync } from "node:child_process";
export const job = tool({ execute: () => execSync("make") });`,
  notATool: `import { generateText } from "ai";
export async function summarize(text: string) {
  return generateText({ prompt: text });
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

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tools given to AI models", () => {
  it("finds tool registrations across frameworks, with their names", () => {
    expect(run().tools.map((t) => `${t.framework} ${t.name}`).sort()).toEqual([
      "@langchain/core shell",
      "@modelcontextprotocol/sdk *",
      "@modelcontextprotocol/sdk ping",
      "@modelcontextprotocol/sdk save_note",
      "@openai/agents browse",
      "@openai/agents cleanup",
      "ai deleteUser",
      "ai weather",
    ]);
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
      "warning byReference.ts:6 cleanup",
      "warning langchain.ts:3 shell",
      "warning lowlevel.ts:5 *",
      "warning mcp.ts:5 save_note",
      "warning vercel.ts:4 deleteUser",
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
    expect(run({ tools: "trust" }).diagnostics.filter((d) => d.code === "PERM008")).toEqual([]);
    // The tools are still listed.
    expect(run({ tools: "trust" }).tools).toHaveLength(8);
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
