// Tools given to AI models. A function registered as a tool (MCP, the Vercel AI SDK,
// OpenAI Agents, LangChain, ...) runs when the model decides to call it, and the model
// does what its input says, so whoever controls that input can trigger it. Prompt
// injection then reaches whatever the tool reaches. This finds the registrations and
// their handlers; check.ts works out what each handler reaches.

import { Node, type CallExpression, type NewExpression, type SourceFile } from "ts-morph";
import { packageOf } from "./adapters.js";
import { literalString, resolvedDeclaration } from "./detect/shared.js";

export interface ToolRegistration {
  /** The tool's name as the model sees it, or `*` for a handler that serves every tool. */
  name: string;
  /** The package it's registered with, such as `ai` or `@modelcontextprotocol/sdk`. */
  framework: string;
  call: CallExpression | NewExpression;
  /** The function that runs when the model calls the tool, if it can be found. */
  handler: Node | undefined;
}

/** Packages whose tool APIs hand a function to a model. */
const AI_PACKAGES = new Set([
  "ai",
  "@modelcontextprotocol/sdk",
  "@openai/agents",
  "@anthropic-ai/sdk",
  "@langchain/core",
  "langchain",
  "@mastra/core",
  "llamaindex",
]);

/** Functions and classes that create or register a tool. */
const TOOL_FUNCTION = /^(tool|registerTool|createTool|dynamicTool|betaTool|betaZodTool|zodTool|FunctionTool)$/;
const TOOL_CLASS = /Tool$/;
/** Where a tool definition keeps its handler. */
const HANDLER_KEYS = new Set(["execute", "run", "func", "handler", "invoke", "callback", "fn"]);

export function findTools(sourceFile: SourceFile): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) return;
    const declaration = resolvedDeclaration(node);
    if (!declaration) return;
    const pkg = packageOf(declaration);
    // The Vercel AI SDK declares tool() in @ai-sdk/provider-utils and re-exports it from ai.
    if (!pkg || (!AI_PACKAGES.has(pkg) && !pkg.startsWith("@ai-sdk/"))) return;
    const framework = pkg.startsWith("@ai-sdk/") ? "ai" : pkg;
    const name = calleeName(node, declaration);
    if (!name) return;
    const args = node.getArguments();

    // MCP's low-level API: one handler serves every tool call.
    if (name === "setRequestHandler") {
      if (args[0] && /CallToolRequestSchema/.test(args[0].getText())) out.push({ name: "*", framework, call: node, handler: args[1] });
      return;
    }
    const isTool = Node.isNewExpression(node) ? TOOL_CLASS.test(name) : TOOL_FUNCTION.test(name);
    if (!isTool) return;
    out.push({ name: toolName(node), framework, call: node, handler: handlerOf(args) });
  });
  return out;
}

/** The called function's or class's name, from its declaration, without a bundler's rename suffix. */
function calleeName(call: CallExpression | NewExpression, declaration: Node): string | undefined {
  return declaredName(call, declaration)?.replace(/\$\d+$/, "");
}

function declaredName(call: CallExpression | NewExpression, declaration: Node): string | undefined {
  if (Node.isNewExpression(call)) {
    const cls = Node.isConstructorDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration) ? declaration.getParent() : declaration;
    return cls && "getName" in cls ? (cls as { getName(): string | undefined }).getName() : undefined;
  }
  const named = Node.isFunctionTypeNode(declaration) || Node.isArrowFunction(declaration) ? declaration.getParent() : declaration;
  return named && "getName" in named ? (named as { getName(): string | undefined }).getName() : undefined;
}

/** The handler: an `execute`/`run`/`func` property of a definition, or the last function argument. */
function handlerOf(args: readonly Node[]): Node | undefined {
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.getProperties()) {
      if (Node.isPropertyAssignment(p) && HANDLER_KEYS.has(p.getName())) return p.getInitializerOrThrow();
      if (Node.isMethodDeclaration(p) && HANDLER_KEYS.has(p.getName())) return p;
      if (Node.isShorthandPropertyAssignment(p) && HANDLER_KEYS.has(p.getName())) return p.getNameNode();
    }
  }
  return [...args].reverse().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || a.getType().getCallSignatures().length > 0);
}

/** The first string argument, else a `name` property, else what the result is assigned to. */
function toolName(call: CallExpression | NewExpression): string {
  const args = call.getArguments();
  const literal = literalString(args[0]);
  if (literal !== undefined) return literal;
  for (const arg of args) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const name = arg.getProperty("name");
    const value = name && Node.isPropertyAssignment(name) ? literalString(name.getInitializer()) : undefined;
    if (value !== undefined) return value;
  }
  const holder = call.getParent();
  if (holder && (Node.isPropertyAssignment(holder) || Node.isVariableDeclaration(holder))) return holder.getName();
  return "tool";
}
