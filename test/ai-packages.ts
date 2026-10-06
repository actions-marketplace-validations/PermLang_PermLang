// AI framework packages for test/tools.test.ts, laid out the way npm publishes them: the
// file structure, re-exports, bundler-renamed declarations, and overloads that decide
// where TypeScript resolves a call. Only the declarations the tests use are kept. A
// hand-written stub that declares `tool` in the package users import hid two bugs (the
// AI SDK's `tool$1`, OpenAI Agents' re-export from @openai/agents-core), so these follow
// the published files instead:
//
//   @openai/agents 0.19.0, @openai/agents-core 0.19.0, @openai/agents-openai 0.19.0
//   @modelcontextprotocol/server 2.3.1 (the MCP SDK's version 2 server package)
//   ai 7.0.127, @ai-sdk/provider-utils 5.0.53, @ai-sdk/anthropic 4.0.71
//   llamaindex 0.12.1, @llamaindex/core 0.6.23
//   @langchain/core 1.2.14

const pkg = (name: string, types: string, extra: object = {}) => JSON.stringify({ name, version: "0.0.0-test", types, ...extra });
const esm = (name: string, types: string) => pkg(name, types, { type: "module", exports: { ".": { import: { types }, require: { types } } } });

export const publishedPackages: Record<string, string> = {
  // --- OpenAI Agents: the package users import re-exports everything from agents-core.
  "@openai/agents/package.json": pkg("@openai/agents", "./dist/index.d.ts"),
  "@openai/agents/dist/index.d.ts": `export * from '@openai/agents-core';
export * from '@openai/agents-openai';
export { applyPatchTool, shellTool } from '@openai/agents-core';
export type { Shell, ShellAction, ShellResult, Editor } from '@openai/agents-core';
`,
  "@openai/agents-core/package.json": pkg("@openai/agents-core", "./dist/index.d.ts"),
  "@openai/agents-core/dist/index.d.ts": `export { ShellAction, ShellResult, Shell } from './shell';
export { Editor } from './editor';
export { Computer } from './computer';
export { Agent } from './agent';
export { HostedTool, ComputerTool, computerTool, ShellTool, shellTool, ApplyPatchTool, applyPatchTool, FunctionTool, Tool, tool } from './tool';
`,
  "@openai/agents-core/dist/shell.d.ts": `export type ShellAction = { commands: string[] };
export type ShellResult = { output: string[] };
export interface Shell {
    run(action: ShellAction): Promise<ShellResult>;
}
`,
  "@openai/agents-core/dist/editor.d.ts": `export interface Editor {
    createFile(path: string, diff: string): Promise<void>;
    updateFile(path: string, diff: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
}
`,
  "@openai/agents-core/dist/computer.d.ts": `export interface Computer {
    environment: 'mac' | 'windows' | 'ubuntu' | 'browser';
    dimensions: [number, number];
    screenshot(): Promise<string>;
    click(x: number, y: number, button: 'left' | 'right'): Promise<void>;
    type(text: string): Promise<void>;
}
`,
  "@openai/agents-core/dist/agent.d.ts": `import type { Tool } from './tool';
export declare class Agent {
    constructor(config: { name: string; instructions?: string; tools?: Tool[] });
}
`,
  "@openai/agents-core/dist/tool.d.ts": `import type { Shell } from './shell';
import type { Editor } from './editor';
import type { Computer } from './computer';
type ComputerProvider = { create: () => Computer | Promise<Computer>; dispose?: () => void | Promise<void> };
type ComputerConfig = Computer | (() => Computer | Promise<Computer>) | ComputerProvider;
export type ComputerTool = { type: 'computer'; name: string; computer: ComputerConfig };
export type FunctionTool = { type: 'function'; name: string; invoke: (input: string) => Promise<unknown> };
export type HostedTool = { type: 'hosted_tool'; name: string };
export type ToolExecuteFunction = (input: any, context?: unknown) => unknown;
type ToolOptions = { name?: string; description: string; parameters: unknown; execute: ToolExecuteFunction; errorFunction?: (context: unknown, error: unknown) => string };
type LocalShellToolOptions = { name?: string; shell: Shell; needsApproval?: boolean };
type HostedShellToolOptions = { name?: string; environment: { type: 'container_auto' }; shell?: never; needsApproval?: never };
type LocalShellTool = { type: 'shell'; name: string; shell: Shell };
type HostedShellTool = { type: 'shell'; name: string; environment: { type: 'container_auto' } };
export type ShellTool = LocalShellTool | HostedShellTool;
export type ApplyPatchTool = { type: 'apply_patch'; name: string; editor: Editor };
export type Tool = FunctionTool | HostedTool | ComputerTool | ShellTool | ApplyPatchTool;
export declare function computerTool(options: { name?: string; computer: ComputerConfig; needsApproval?: boolean }): ComputerTool;
export declare function shellTool(options: LocalShellToolOptions): LocalShellTool;
export declare function shellTool(options: HostedShellToolOptions): HostedShellTool;
export declare function applyPatchTool(options: { name?: string; editor: Editor }): ApplyPatchTool;
export declare function tool(options: ToolOptions): FunctionTool;
`,
  "@openai/agents-openai/package.json": pkg("@openai/agents-openai", "./dist/index.d.ts"),
  "@openai/agents-openai/dist/index.d.ts": `export { fileSearchTool, webSearchTool } from './tools';
`,
  "@openai/agents-openai/dist/tools.d.ts": `import { HostedTool } from '@openai/agents-core';
export declare function webSearchTool(options?: { searchContextSize?: 'low' | 'medium' | 'high' }): HostedTool;
export declare function fileSearchTool(vectorStoreIds: string | string[], options?: { maxNumResults?: number }): HostedTool;
`,

  // --- MCP SDK version 2: the server package's index re-exports minified names from a chunk.
  "@modelcontextprotocol/server/package.json": esm("@modelcontextprotocol/server", "./dist/index.d.mts"),
  "@modelcontextprotocol/server/dist/index.d.mts": `import { w as McpServer, I as Server } from "./createMcpHandler-D4NN8WsG.mjs";
export { McpServer, Server };
`,
  "@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts": `type CallToolResult = { content: { type: "text"; text: string }[] };
type ToolCallback<Args> = (args: Args, ctx: unknown) => CallToolResult | Promise<CallToolResult>;
declare class Protocol<ContextT> {
  setRequestHandler(method: string, handler: (request: any, ctx: ContextT) => unknown): void;
  setRequestHandler(method: string, schemas: { params: unknown }, handler: (params: any, ctx: ContextT) => unknown): void;
}
declare class Server extends Protocol<object> {
  constructor(serverInfo: { name: string; version: string }, options?: object);
}
declare class McpServer {
  readonly server: Server;
  constructor(serverInfo: { name: string; version: string });
  registerTool<InputArgs>(name: string, config: { title?: string; description?: string; inputSchema?: InputArgs }, cb: ToolCallback<any>): { remove(): void };
}
export { McpServer as w, Server as I };
`,

  // --- Vercel AI SDK 7: tool() is declared in provider-utils as tool$1; ai re-exports it.
  "@ai-sdk/provider-utils/package.json": pkg("@ai-sdk/provider-utils", "./dist/index.d.ts"),
  "@ai-sdk/provider-utils/dist/index.d.ts": `type ToolExecuteFunction<INPUT, OUTPUT> = (input: INPUT, options: { toolCallId: string }) => OUTPUT | Promise<OUTPUT>;
type BaseTool<INPUT, OUTPUT> = { inputSchema?: unknown; execute?: ToolExecuteFunction<INPUT, OUTPUT>; onInputStart?: () => void };
type FunctionTool<INPUT = any, OUTPUT = any> = BaseTool<INPUT, OUTPUT> & { type?: 'function'; description?: string };
type BaseProviderTool<INPUT, OUTPUT> = BaseTool<INPUT, OUTPUT> & { type: 'provider'; id: \`\${string}.\${string}\`; args: Record<string, unknown> };
type ProviderDefinedTool<INPUT = any, OUTPUT = any> = BaseProviderTool<INPUT, OUTPUT> & { isProviderExecuted: false };
type ProviderExecutedTool<INPUT = any, OUTPUT = any> = BaseProviderTool<INPUT, OUTPUT> & { isProviderExecuted: true };
type Tool<INPUT = any, OUTPUT = any> = FunctionTool<INPUT, OUTPUT> | ProviderDefinedTool<INPUT, OUTPUT> | ProviderExecutedTool<INPUT, OUTPUT>;
type ExecutableTool<T> = T & { execute: NonNullable<unknown> };
type ToolSet = Record<string, Tool<any, any> & Pick<Tool<any, any>, 'execute'>>;
declare function tool$1<INPUT, OUTPUT>(tool: Tool<INPUT, OUTPUT> & { execute: ToolExecuteFunction<INPUT, OUTPUT> }): ExecutableTool<Tool<INPUT, OUTPUT>>;
declare function tool$1<INPUT, OUTPUT>(tool: Tool<INPUT, OUTPUT>): Tool<INPUT, OUTPUT>;
type ProviderExecutedToolFactory<INPUT, OUTPUT, ARGS extends object> = (options: ARGS & { onInputStart?: () => void }) => ProviderExecutedTool<INPUT, OUTPUT>;
export { type ProviderDefinedTool, type ProviderExecutedTool, type ProviderExecutedToolFactory, type Tool, type ToolExecuteFunction, type ToolSet, tool$1 as tool };
`,
  "ai/package.json": pkg("ai", "./dist/index.d.ts"),
  "ai/dist/index.d.ts": `import { ToolSet, tool as tool$1 } from '@ai-sdk/provider-utils';
export { tool$1 as tool };
export declare function generateText<TOOLS extends ToolSet>({ prompt, tools }: { model?: string; prompt: string; tools?: TOOLS; experimental_sandbox?: unknown }): Promise<{ text: string }>;
export declare class ToolLoopAgent<TOOLS extends ToolSet = {}> {
  constructor(settings: { model?: string; instructions?: string; tools?: TOOLS });
  generate(options: { prompt: string }): Promise<{ text: string }>;
}
`,
  "@ai-sdk/anthropic/package.json": pkg("@ai-sdk/anthropic", "./dist/index.d.ts"),
  "@ai-sdk/anthropic/dist/index.d.ts": `import * as _ai_sdk_provider_utils0 from "@ai-sdk/provider-utils";
import { ProviderDefinedTool, ToolExecuteFunction } from "@ai-sdk/provider-utils";
type Bash20250124Input = { command: string; restart?: boolean };
type Bash20250124Options<OUTPUT> = { execute?: ToolExecuteFunction<Bash20250124Input, OUTPUT>; needsApproval?: boolean };
declare function bash_20250124(options?: Omit<Bash20250124Options<string>, 'execute'> & {
  execute?: undefined;
}): ProviderDefinedTool<Bash20250124Input, string>;
declare function bash_20250124<OUTPUT>(options: Omit<Bash20250124Options<OUTPUT>, 'execute'> & {
  execute: Bash20250124Options<OUTPUT>['execute'];
}): ProviderDefinedTool<Bash20250124Input, OUTPUT>;
declare const anthropicTools: {
  bash_20250124: typeof bash_20250124;
  codeExecution_20250522: (args?: Parameters<_ai_sdk_provider_utils0.ProviderExecutedToolFactory<{ code: string }, { stdout: string }, {}>>[0]) => _ai_sdk_provider_utils0.ProviderExecutedTool<{ code: string }, { stdout: string }>;
};
interface AnthropicProvider {
  (modelId: string): string;
  tools: typeof anthropicTools;
}
export declare const anthropic: AnthropicProvider;
`,

  // --- LlamaIndex: llamaindex re-exports @llamaindex/core/tools through its own tools folder.
  "llamaindex/package.json": pkg("llamaindex", "./dist/type/index.d.ts"),
  "llamaindex/dist/type/index.d.ts": `export * from '../../tools/dist/index.js';
`,
  "llamaindex/tools/dist/index.d.ts": `export * from '@llamaindex/core/tools';
`,
  "@llamaindex/core/package.json": JSON.stringify({ name: "@llamaindex/core", version: "0.0.0-test", exports: { "./tools": { import: { types: "./tools/dist/index.d.ts" }, require: { types: "./tools/dist/index.d.ts" } } } }),
  "@llamaindex/core/tools/dist/index.d.ts": `type JSONValue = string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[];
type ToolMetadata = { name: string; description: string; parameters?: object };
declare class FunctionTool<T, R extends JSONValue | Promise<JSONValue>> {
    constructor(fn: (input: T) => R, metadata: ToolMetadata);
    static from<T>(fn: (input: T) => JSONValue | Promise<JSONValue>, schema: ToolMetadata): FunctionTool<T, JSONValue | Promise<JSONValue>>;
    static from<R>(config: Omit<ToolMetadata, "parameters"> & {
        parameters: R;
        execute: (input: any) => JSONValue | Promise<JSONValue>;
    }): FunctionTool<any, JSONValue | Promise<JSONValue>>;
    call: (input: T) => R;
}
/**
 * A simpler alias for creating a FunctionTool.
 */
declare const tool: typeof FunctionTool.from;

export { FunctionTool, tool };
`,

  // --- LangChain community's prebuilt tools: a library's class, whose code can't be seen.
  "@langchain/community/package.json": JSON.stringify({ name: "@langchain/community", version: "0.0.0-test", exports: { "./tools/calculator": { import: { types: "./tools/calculator.d.ts" }, require: { types: "./tools/calculator.d.ts" } } } }),
  "@langchain/community/tools/calculator.d.ts": `import { Tool } from "@langchain/core/tools";
export declare class Calculator extends Tool {
  name: string;
  description: string;
  constructor();
  protected _call(input: string): Promise<string>;
}
`,

  // --- LangChain: the tools entry point re-exports dist/tools; StructuredTool runs \`_call\`.
  "@langchain/core/package.json": JSON.stringify({ name: "@langchain/core", version: "0.0.0-test", exports: { "./tools": { import: { types: "./dist/tools/index.d.ts" }, require: { types: "./dist/tools/index.d.ts" } } } }),
  "@langchain/core/dist/tools/index.d.ts": `declare abstract class BaseLangChain {
  invoke(input: unknown): Promise<unknown>;
}
declare abstract class StructuredTool<SchemaT = unknown> extends BaseLangChain {
  abstract name: string;
  abstract description: string;
  abstract schema: SchemaT;
  constructor(fields?: { verbose?: boolean });
  protected abstract _call(arg: any): Promise<unknown>;
}
declare abstract class Tool extends StructuredTool<string> {
  schema: string;
}
declare class DynamicStructuredTool<SchemaT = unknown> extends StructuredTool<SchemaT> {
  name: string;
  description: string;
  schema: SchemaT;
  constructor(fields: { name: string; description: string; schema: SchemaT; func: (input: any) => Promise<unknown> | unknown });
  protected _call(arg: any): Promise<unknown>;
}
declare function tool<SchemaT>(func: (input: any) => unknown, fields: { name: string; description?: string; schema: SchemaT }): DynamicStructuredTool<SchemaT>;
export { DynamicStructuredTool, StructuredTool, Tool, tool };
`,
};
