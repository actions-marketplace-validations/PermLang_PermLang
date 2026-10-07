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
//   openai 7.28.0, fastmcp 4.22.4, genkit 1.42.0, @genkit-ai/ai 1.42.0

const pkg = (name: string, types: string, extra: object = {}) => JSON.stringify({ name, version: "0.0.0-test", types, ...extra });
const esm = (name: string, types: string) => pkg(name, types, { type: "module", exports: { ".": { import: { types }, require: { types } } } });

// The openai package's declarations, by path without the extension, written with ESM specifiers.
// It publishes each twice, as .d.mts for import and .d.ts for require, and which one TypeScript
// reads depends on how the importing file is loaded.
const openaiTypes: Record<string, string> = {
  "index": `export { OpenAI as default } from "./client.mjs";
export { OpenAI } from "./client.mjs";
`,
  "client": `import { Chat } from "./resources/chat/chat.mjs";
import { Responses } from "./resources/responses/responses.mjs";
import { Beta } from "./resources/beta/beta.mjs";
export declare class OpenAI {
    constructor(options?: { apiKey?: string });
    chat: Chat;
    responses: Responses;
    beta: Beta;
}
`,
  // The beta Agents API: a session turn runs the handlers in its toolHandlers record.
  "resources/beta/beta": `import * as AgentsAPI from "./agents/agents.mjs";
export declare class Beta {
    agents: AgentsAPI.Agents;
}
`,
  "resources/beta/agents/agents": `import * as SessionsAPI from "./sessions/sessions.mjs";
export declare class Agents {
    sessions: SessionsAPI.Sessions;
}
`,
  "resources/beta/agents/sessions/sessions": `import { AgentSessionStream, type AgentSessionStreamParams } from "../../../../lib/agents/agent-session-stream.mjs";
export declare class Sessions {
    stream<T = never>(sessionID: string, params: AgentSessionStreamParams<T>): AgentSessionStream<T>;
}
`,
  "lib/agents/agent-session-stream": `export type AgentToolOutput = object | null;
export type AgentToolHandler = (arguments_: Record<string, unknown>) => AgentToolOutput | PromiseLike<AgentToolOutput>;
export type AgentSessionStreamParams<T = never> = {
    input: string;
    toolHandlers?: Record<string, AgentToolHandler>;
    idempotencyKey?: string;
};
export declare class AgentSessionStream<T> {
    finalResult(): Promise<T>;
}
`,
  "resources/chat/chat": `import * as CompletionsAPI from "./completions/completions.mjs";
export declare class Chat {
    completions: CompletionsAPI.Completions;
}
`,
  "resources/chat/completions/completions": `import type { RunnableToolFunctionWithContext, RunnableTools } from "../../../lib/RunnableFunction.mjs";
import type { AutoParseableTool } from "../../../lib/parser.mjs";
import type { FunctionDefinition } from "../../shared.mjs";
export interface ChatCompletionFunctionTool {
    function: FunctionDefinition;
    type: 'function';
}
export interface ChatCompletionCustomTool {
    custom: { name: string; description?: string };
    type: 'custom';
}
export type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;
type ChatCompletionToolRunnerParamsWithoutContext = { model: string; messages: unknown[]; tools: RunnableTools<any[]> | AutoParseableTool<any, true>[]; toolContext?: never };
declare class ChatCompletionRunner {
    finalContent(): Promise<string | null>;
}
export declare class Completions {
    create(body: { model: string; messages: unknown[]; tools?: ChatCompletionTool[] }): Promise<unknown>;
    runTools<ToolContext>(body: { model: string; messages: unknown[]; toolContext: ToolContext; tools: readonly RunnableToolFunctionWithContext<ToolContext>[] }): ChatCompletionRunner;
    runTools<Params extends ChatCompletionToolRunnerParamsWithoutContext>(body: Params): ChatCompletionRunner;
}
`,
  "resources/shared": `export type FunctionParameters = { [key: string]: unknown };
export interface FunctionDefinition {
    name: string;
    description?: string;
    parameters?: FunctionParameters;
    strict?: boolean | null;
}
`,
  "resources/responses/responses": `import type { FunctionParameters } from "../shared.mjs";
export interface FunctionTool {
    name: string;
    parameters: FunctionParameters | null;
    strict: boolean | null;
    type: 'function';
}
export interface WebSearchTool {
    type: 'web_search';
}
export type Tool = FunctionTool | WebSearchTool;
export declare class Responses {
    create(body: { model: string; input: string; tools?: Tool[] }): Promise<unknown>;
}
`,
  "lib/RunnableFunction": `type PromiseOrValue<T> = T | Promise<T>;
export type RunnableFunctionWithParse<Args extends object, ToolContext = unknown> = {
    function: (args: Args, runner: unknown, toolContext: ToolContext) => PromiseOrValue<unknown>;
    parse: (input: string) => PromiseOrValue<Args>;
    parameters: Record<string, unknown>;
    description: string;
    name?: string | undefined;
};
export type RunnableFunctionWithoutParse<ToolContext = unknown> = {
    function: (args: string, runner: unknown, toolContext: ToolContext) => PromiseOrValue<unknown>;
    parameters: Record<string, unknown>;
    description: string;
    name?: string | undefined;
};
export type RunnableToolFunctionWithoutParse<ToolContext = unknown> = { type: 'function'; function: RunnableFunctionWithoutParse<ToolContext> };
export type RunnableToolFunctionWithParse<Args extends object, ToolContext = unknown> = { type: 'function'; function: RunnableFunctionWithParse<Args, ToolContext> };
export type RunnableToolFunction<Args extends object | string, ToolContext = unknown> = Args extends string ? RunnableToolFunctionWithoutParse<ToolContext> : Args extends object ? RunnableToolFunctionWithParse<Args, ToolContext> : never;
export type RunnableToolFunctionWithContext<ToolContext> = {
    type: 'function';
    function: {
        function: (args: any, runner: unknown, toolContext: ToolContext) => PromiseOrValue<unknown>;
        parse?: (input: string) => PromiseOrValue<any>;
        parameters: Record<string, unknown>;
        description: string;
        name?: string | undefined;
    };
};
export type BaseFunctionsArgs = readonly (object | string)[];
export type RunnableTools<FunctionsArgs extends BaseFunctionsArgs, ToolContext = unknown> = [any[]] extends [FunctionsArgs] ? readonly RunnableToolFunction<any, ToolContext>[] : never;
export declare class ParsingToolFunction<Args extends object, ToolContext = unknown> {
    type: "function";
    function: RunnableFunctionWithParse<Args, ToolContext>;
    constructor(input: RunnableFunctionWithParse<Args, ToolContext>);
}
`,
  "lib/parser": `import type { ChatCompletionFunctionTool } from "../resources/chat/completions/completions.mjs";
type ToolOptions = { name: string; arguments: any; function?: ((args: any) => any) | undefined };
export type AutoParseableTool<OptionsT extends ToolOptions, HasFunction = OptionsT['function'] extends (...args: never[]) => unknown ? true : false> = ChatCompletionFunctionTool & {
    __arguments: OptionsT['arguments'];
    __hasFunction: HasFunction;
    $callback: ((args: OptionsT['arguments']) => any) | undefined;
};
`,
  "helpers/zod": `import type { AutoParseableTool } from "../lib/parser.mjs";
type ZodTypeLike = { parse(input: unknown): unknown };
type InferZodType<T> = T extends { parse(input: unknown): infer R } ? R : never;
interface ZodFunctionOptions<Parameters extends ZodTypeLike> {
    name: string;
    parameters: Parameters;
    function?: ((args: InferZodType<Parameters>) => unknown | Promise<unknown>) | undefined;
    description?: string | undefined;
}
type ZodFunctionTool<Parameters extends ZodTypeLike, Callback extends ZodFunctionOptions<Parameters>['function']> = AutoParseableTool<{
    arguments: InferZodType<Parameters>;
    name: string;
    function: Callback;
}>;
export declare function zodFunction<Parameters extends ZodTypeLike>(options: ZodFunctionOptions<Parameters> & {
    function: NonNullable<ZodFunctionOptions<Parameters>['function']>;
}): ZodFunctionTool<Parameters, NonNullable<ZodFunctionOptions<Parameters>['function']>>;
export declare function zodFunction<Parameters extends ZodTypeLike>(options: ZodFunctionOptions<Parameters>): ZodFunctionTool<Parameters, ZodFunctionOptions<Parameters>['function']>;
`,
};


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
export { HostedTool, ComputerTool, computerTool, ShellTool, shellTool, ApplyPatchTool, applyPatchTool, HostedMCPTool, hostedMcpTool, FunctionTool, Tool, tool } from './tool';
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
export type HostedMCPApprovalFunction = (context: unknown, data: { toolName: string; arguments: string }) => Promise<{
    approve: boolean;
    reason?: string;
}>;
export type HostedMCPTool = HostedTool & { name: 'hosted_mcp'; providerData: object };
export declare function hostedMcpTool(options: { serverLabel: string; serverUrl?: string } & ({ requireApproval?: 'never' } | { requireApproval: 'always'; onApproval?: HostedMCPApprovalFunction })): HostedMCPTool;
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

  // --- OpenAI's SDK: chat.completions.runTools runs the functions in its tools. The client's
  // resources are classes in their own files, and the helpers are imported by path
  // (openai/helpers/zod, openai/lib/RunnableFunction). See openaiTypes above.
  "openai/package.json": JSON.stringify({
    name: "openai",
    version: "0.0.0-test",
    types: "./index.d.ts",
    exports: {
      ".": { require: { types: "./index.d.ts" }, types: "./index.d.mts" },
      "./helpers/*": { import: "./helpers/*.mjs", require: "./helpers/*.js" },
      "./lib/*": { import: "./lib/*.mjs", require: "./lib/*.js" },
    },
  }),
  ...bothFormats("openai", openaiTypes),

  // --- FastMCP: a class with addTool and addTools, in one bundled declaration file.
  "fastmcp/package.json": JSON.stringify({ name: "fastmcp", version: "0.0.0-test", type: "module", types: "dist/FastMCP.d.ts", exports: { ".": { import: "./dist/FastMCP.js", types: "./dist/FastMCP.d.ts" } } }),
  "fastmcp/dist/FastMCP.d.ts": `type Context<T> = { session: T | undefined; log: { info(message: string): void } };
type FastMCPSessionAuth = Record<string, unknown> | undefined;
type Tool<T extends FastMCPSessionAuth, Params = unknown> = {
    canAccess?: (auth: T) => boolean;
    description?: string;
    execute: (args: any, context: Context<T>) => Promise<string | void>;
    name: string;
    parameters?: Params;
};
declare class FastMCPEventEmitter {
    on(event: string, listener: (...args: unknown[]) => void): this;
}
declare class FastMCP<T extends FastMCPSessionAuth = FastMCPSessionAuth> extends FastMCPEventEmitter {
    constructor(options: { name: string; version: \`\${number}.\${number}.\${number}\` });
    addTool<Params>(tool: Tool<T, Params>): void;
    addTools<Params>(tools: Tool<T, Params>[]): void;
}
export { FastMCP, type Tool };
`,

  // --- Genkit: genkit() returns a Genkit instance with defineTool; tool() and dynamicTool() come
  // from @genkit-ai/ai/tool, re-exported under minified names from a chunk.
  "genkit/package.json": JSON.stringify({ name: "genkit", version: "0.0.0-test", types: "lib/index.d.ts", exports: { ".": { types: "./lib/index.d.ts" } } }),
  "genkit/lib/index.d.ts": `export { ToolAction, dynamicTool, tool } from '@genkit-ai/ai/tool';
export { a as Genkit, j as genkit } from './index-BSkuxdwl.js';
`,
  "genkit/lib/index-BSkuxdwl.d.ts": `import { ToolAction, ToolConfig, ToolFn } from '@genkit-ai/ai/tool';
declare class Genkit {
    defineTool<I, O>(config: ToolConfig<I, O>, fn: ToolFn<I, O>): ToolAction<I, O>;
    dynamicTool<I, O>(config: ToolConfig<I, O>, fn?: ToolFn<I, O>): ToolAction<I, O>;
    generate(options: { prompt: string; tools?: (ToolAction<any, any> | string)[] }): Promise<{ text: string }>;
}
declare function genkit(options: { plugins?: unknown[] }): Genkit;
export { Genkit as a, genkit as j };
`,
  "@genkit-ai/ai/package.json": JSON.stringify({ name: "@genkit-ai/ai", version: "0.0.0-test", exports: { "./tool": { types: "./lib/tool.d.ts" } } }),
  "@genkit-ai/ai/lib/tool.d.ts": `export { T as ToolAction, r as ToolConfig, Z as ToolFn, $ as dynamicTool, a7 as tool } from './prompt-CdiaLTJP.js';
`,
  "@genkit-ai/ai/lib/prompt-CdiaLTJP.d.ts": `type ToolConfig<I, O> = { name: string; description: string; inputSchema?: I; outputSchema?: O };
type ToolFn<I, O> = (input: any, ctx: { context: unknown }) => Promise<unknown>;
type ToolAction<I = unknown, O = unknown> = ((input: any) => Promise<unknown>) & { __action: { name: string; inputSchema?: I; outputSchema?: O } };
declare function tool<I, O>(config: ToolConfig<I, O>, fn?: ToolFn<I, O>): ToolAction<I, O>;
declare function dynamicTool<I, O>(config: ToolConfig<I, O>, fn?: ToolFn<I, O>): ToolAction<I, O>;
export { ToolAction as T, ToolConfig as r, ToolFn as Z, dynamicTool as $, tool as a7 };
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

function bothFormats(name: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).flatMap(([file, text]) => [
      [`${name}/${file}.d.mts`, text],
      [`${name}/${file}.d.ts`, text.replaceAll('.mjs"', '.js"')],
    ]),
  );
}
