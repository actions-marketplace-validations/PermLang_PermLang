// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Tools given to AI models. A function registered as a tool (MCP, the Vercel AI SDK,
// OpenAI Agents, LangChain, ...) runs when the model decides to call it, and the model
// does what its input says, so whoever controls that input can trigger it. Prompt
// injection then reaches whatever the tool reaches. This finds the registrations and
// their handlers, and works out what each handler reaches.

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type BinaryExpression,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ElementAccessExpression,
  type NewExpression,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type Type,
  type VariableDeclaration,
} from "ts-morph";
import { packageOf } from "./adapters.js";
import { UNVERIFIABLE, formatCapability } from "./capability.js";
import { literalString, resolveAlias, resolvedDeclaration, unwrapExpression } from "./detect/shared.js";
import type { Edge, Reach } from "./graph.js";
import { constructorUnitNode, enclosingUnitNode, isInNodeModules, unitNodeForDeclaration, unitNodesForSymbol, type Unit } from "./units.js";
import { forEachDescendant } from "./walk.js";

export interface ToolRegistration {
  /** The tool's name as the model sees it, or `*` for a handler that serves every tool. */
  name: string;
  /** The package it's registered with, such as `ai` or `@modelcontextprotocol/sdk`. */
  framework: string;
  /** Where it's registered: the call or `new`, or the tool's entry in a `tools: { ... }` option. */
  site: Node;
  /** What runs when the model calls the tool: a function, or an object or class whose methods do. */
  handler: Node | undefined;
  /**
   * The tool runs at the model provider (a hosted web search, say): no code here runs for it,
   * except callbacks it's given (a hosted MCP server's `onApproval`). These are its arguments.
   */
  hosted?: readonly Node[];
  /** Tools given in a way that can't be listed: a whole collection (named `*`), or one entry of it. */
  unlisted?: boolean;
}

/**
 * Packages whose tool APIs hand a function to a model, by family: a package re-exports
 * others of its family (`@openai/agents` re-exports `tool` from `@openai/agents-core`, `ai`
 * re-exports it from `@ai-sdk/provider-utils`), and what's found is where it's declared.
 */
const FAMILIES: { matches: (pkg: string) => boolean; name?: string }[] = [
  { matches: (p) => p === "ai" || p.startsWith("@ai-sdk/"), name: "ai" },
  { matches: (p) => p === "@openai/agents" || p.startsWith("@openai/agents-"), name: "@openai/agents" },
  { matches: (p) => p.startsWith("@modelcontextprotocol/") },
  { matches: (p) => p.startsWith("@anthropic-ai/") },
  { matches: (p) => p === "langchain" || p.startsWith("@langchain/") },
  { matches: (p) => p === "llamaindex" || p.startsWith("@llamaindex/") },
  { matches: (p) => p.startsWith("@mastra/") },
  { matches: (p) => p === "openai" },
  { matches: (p) => p === "fastmcp" },
  { matches: (p) => p === "genkit" || p.startsWith("@genkit-ai/"), name: "genkit" },
];

/** The framework a package belongs to, as reported, or undefined if it isn't one. */
export function aiFramework(pkg: string | undefined): string | undefined {
  if (pkg === undefined) return undefined;
  const family = FAMILIES.find((f) => f.matches(pkg));
  return family && (family.name ?? pkg);
}

/**
 * Functions (and classes) that create or register a tool, including OpenAI Agents' built-in
 * tools that run here, FastMCP's `addTool`, Genkit's `defineTool`, and the OpenAI SDK's
 * function-tool helpers (`zodFunction({ function })`, `new ParsingToolFunction(...)`).
 */
const TOOL_FUNCTION =
  /^(tool|registerTool|createTool|dynamicTool|betaTool|betaZodTool|zodTool|FunctionTool|shellTool|computerTool|applyPatchTool|addTool|defineTool|zodFunction|zodResponsesFunction|standardFunction|standardResponsesFunction|ParsingToolFunction)$/;
/** Classes, and the types factories return (`ProviderDefinedTool`, `FunctionTool`), that are tools. */
const TOOL_CLASS = /Tool$/;
/** Where a tool definition keeps the function that runs (`function` is the OpenAI SDK's). */
const FUNCTION_KEYS = new Set(["execute", "run", "func", "handler", "invoke", "callback", "fn", "function"]);
/** Where a built-in tool keeps the object that runs it: OpenAI Agents' shellTool, computerTool, applyPatchTool. */
const IMPLEMENTATION_KEYS = new Set(["shell", "computer", "editor"]);
/** The types of tools that run at the model provider. */
const HOSTED_TOOL = /^(Hosted\w*Tool|ProviderExecutedTool)$/;

export function findTools(sourceFile: SourceFile): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  // The iterative walk, so very deeply nested code can't overflow the stack.
  forEachDescendant(sourceFile, (node) => {
    if (Node.isCallExpression(node) || Node.isNewExpression(node)) out.push(...registrationsAt(node));
  });
  return out;
}

function registrationsAt(call: CallExpression | NewExpression): ToolRegistration[] {
  // `new ShellTool()` of your own subclass of a framework's tool class.
  const subclass = Node.isNewExpression(call) ? toolSubclass(call) : undefined;
  if (subclass) return [subclass];

  const declaration = resolvedDeclaration(call);
  const framework = declaration && aiFramework(packageOf(declaration));
  if (!declaration || !framework) return [];
  const args = call.getArguments();
  const name = calleeName(call, declaration);

  // MCP's low-level API: one handler serves every tool call.
  if (name === "setRequestHandler") {
    return servesToolCalls(args[0]) ? [{ name: "*", framework, site: call, handler: lastFunction(args) }] : [];
  }
  if (isToolFactory(call, name)) return [{ name: toolName(call), framework, site: call, ...handlerOf(call) }];
  return collectedTools(call, name, framework);
}

/** A call or `new` that registers a tool: a framework's tool factory, or your own subclass of its tool class. */
function isRegistration(call: CallExpression | NewExpression): boolean {
  if (Node.isNewExpression(call) && toolSubclass(call)) return true;
  const declaration = resolvedDeclaration(call);
  return declaration !== undefined && aiFramework(packageOf(declaration)) !== undefined && isToolFactory(call, calleeName(call, declaration));
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

/**
 * A call that makes a tool: by name (`tool`, `registerTool`, ...), a class named `...Tool` or
 * extending one (LangChain's prebuilt `Calculator` extends `Tool`), or a factory that returns a
 * tool type, which covers provider tools such as `anthropic.tools.bash_20250124(...)` and
 * LlamaIndex's `FunctionTool.from(...)`.
 */
function isToolFactory(call: CallExpression | NewExpression, name: string | undefined): boolean {
  if (Node.isNewExpression(call)) return TOOL_CLASS.test(String(name)) || TOOL_FUNCTION.test(String(name)) || frameworkToolBase(classOf(call.getExpression())) !== undefined;
  return TOOL_FUNCTION.test(String(name)) || TOOL_CLASS.test(String(frameworkTypeName(call)));
}

/** The name of the type a call returns, when an AI framework declares it: a type of your own doesn't count. */
function frameworkTypeName(call: CallExpression | NewExpression): string | undefined {
  const type = call.getType();
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  return declaration && aiFramework(packageOf(declaration)) !== undefined ? symbol.getName() : undefined;
}

/**
 * MCP's request handler for tool calls: `CallToolRequestSchema` (version 1), compared by symbol
 * so a renamed import still counts, or the method name `"tools/call"` (version 2). A method
 * that can't be determined could be tool calls.
 */
function servesToolCalls(arg: Node | undefined): boolean {
  if (!arg) return false;
  const literal = literalString(arg);
  if (literal !== undefined) return literal === "tools/call";
  const target = Node.isPropertyAccessExpression(arg) ? arg.getNameNode() : arg;
  const symbol = target.getSymbol();
  if (!symbol) return true;
  const resolved = resolveAlias(symbol);
  const declaration = resolved.getDeclarations()[0];
  // A schema the SDK declares is known; anything else (a parameter, a variable) could be tool calls.
  if (declaration && aiFramework(packageOf(declaration)) !== undefined) return resolved.getName() === "CallToolRequestSchema";
  return true;
}

/**
 * The handler: the last function argument (MCP's callback, LangChain's `tool(func, ...)`,
 * LlamaIndex's `FunctionTool.from(fn, ...)`), else a definition's `execute`/`run`/`func`
 * function, or a built-in tool's `shell`/`computer`/`editor` object. Without one, only a
 * tool whose type says it runs at the provider reaches nothing here.
 */
function handlerOf(call: CallExpression | NewExpression): Pick<ToolRegistration, "handler" | "hosted"> {
  const args = call.getArguments();
  const fn = lastFunction(args);
  if (fn) return { handler: fn };
  for (const arg of args) {
    const definition = objectLiteralOf(arg);
    const handler = definition && definitionHandler(definition);
    if (handler) return { handler };
  }
  return runsAtProvider(call) ? { handler: undefined, hosted: args } : { handler: undefined };
}

function lastFunction(args: readonly Node[]): Node | undefined {
  return [...args].reverse().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || a.getType().getCallSignatures().length > 0);
}

/**
 * A definition's handler property. A property named like one that isn't a function (MCP's
 * schema `{ run: "boolean" }`) isn't it; one typed `any` (`execute: execSync as any`) is a
 * second choice, after real functions.
 */
function definitionHandler(definition: ObjectLiteralExpression, depth = 0): Node | undefined {
  let untyped: Node | undefined;
  let unknownKey: Node | undefined;
  for (const p of definition.getProperties()) {
    // A definition spread in from a constant: its handler counts (`tool({ ...shellDefinition })`).
    if (Node.isSpreadAssignment(p)) {
      const spread = depth < 8 ? objectLiteralOf(p.getExpression()) : undefined;
      untyped ??= spread && definitionHandler(spread, depth + 1);
      continue;
    }
    const key = keyOf(p);
    if (key !== undefined && IMPLEMENTATION_KEYS.has(key)) return p;
    if (key !== undefined && !FUNCTION_KEYS.has(key)) continue;
    // A method, or a property or shorthand whose value is a function.
    const type = p.getType();
    if (type.getCallSignatures().length > 0) {
      if (key !== undefined) return p;
      // A computed key that can't be read (`[k]: fn`) could be the handler's.
      unknownKey ??= p;
    } else if (type.isAny()) untyped ??= p;
  }
  return untyped ?? unknownKey;
}

/** A property's key as the program sees it: `execute`, `"execute"`, `[K]` with a constant K; undefined when it can't be known. */
function keyOf(property: ObjectLiteralElementLike): string | undefined {
  if (Node.isSpreadAssignment(property)) return undefined;
  const name = property.getNameNode();
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

/**
 * A tool that runs at the model provider, as its framework's type says: OpenAI Agents'
 * `HostedTool` (a web search, a hosted shell) and the AI SDK's `ProviderExecutedTool` (code
 * execution). Any other tool without a handler here could run code that can't be seen: the AI
 * SDK hands its calls back to the app, a provider tool like `bash_20250124()` runs them in a
 * sandbox, and a library's tool class runs its own code.
 */
function runsAtProvider(call: CallExpression | NewExpression): boolean {
  return HOSTED_TOOL.test(String(frameworkTypeName(call)));
}

// --- tools given in a collection ------------------------------------------------
//
// A `tools` option (`generateText({ tools: { shell: { execute } } })`, `new Agent({ tools: [...] })`,
// `runTools({ tools: [...] })`), the OpenAI SDK's `toolHandlers` record, and FastMCP's
// `addTools([...])`. Each entry is a plain object with a handler (a tool), a schema (the app
// answers the model itself), a tool a framework built (registered where it's made), or a
// tool's name. Anything else could be any tool, and so could a collection that can't be
// listed: a parameter, a function's result, `Object.fromEntries(...)`, options spread in from
// elsewhere, or a record changed in ways that can't be read. Each of those is reported as a
// tool that can't be followed, when its type allows a tool the framework runs: a schema-only
// list (the OpenAI SDK's `create({ tools })`) can't hold one.

interface Entry {
  /** Where it's written: an element, a record's property, or an assignment that adds it. */
  site: Node;
  /** Its key in a record, when it's known. */
  key?: string;
  value: Node;
}

/** What a collection holds: entries that can be read, and parts that can't. */
interface Listing {
  entries: Entry[];
  unlisted: Node[];
}

/** The tools a call to an AI framework is given in a collection. */
function collectedTools(call: CallExpression | NewExpression, name: string | undefined, framework: string): ToolRegistration[] {
  const args = call.getArguments();
  const out: ToolRegistration[] = [];
  if (name === "addTools" && args[0]) out.push(...listedTools(args[0], framework, false));
  for (const [i, arg] of args.entries()) {
    for (const key of ["tools", "toolHandlers"]) {
      for (const option of optionValues(arg, key, declaredOption(call, i, key))) {
        if ("value" in option) out.push(...listedTools(option.value, framework, key === "toolHandlers"));
        else out.push(unlistedTool(option.unseen, framework));
      }
    }
  }
  return out;
}

/** The type of option `key` in the parameter at `index` of the signature a call resolves to, if it has one. */
function declaredOption(call: CallExpression | NewExpression, index: number, key: string): Type | undefined {
  // (registrationsAt resolved this call already, through resolvedDeclaration, so it resolves.)
  const parameter = call.getProject().getTypeChecker().getResolvedSignature(call)?.getParameters()[index];
  return parameter?.getTypeAtLocation(call).getProperty(key)?.getTypeAtLocation(call);
}

/**
 * Where an options argument sets `key`: the values it's given, and options that can't be read
 * and could set it to tools (`generateText(options)`, `{ ...options, prompt }`). For an
 * argument that isn't written out, its parameter's declared type says whether it could.
 */
function optionValues(options: Node, key: string, declared: Type | undefined, depth = 0): ({ value: Node } | { unseen: Node })[] {
  const literal = depth <= 8 ? objectLiteralOf(options) : undefined;
  if (!literal) {
    const type = options.getType();
    const own = type.isAny() || type.isUnknown() ? undefined : type.getProperty(key)?.getTypeAtLocation(options);
    const could = depth === 0 ? declared !== undefined && holdsTools(declared, options) : type.isAny() || type.isUnknown() || (own !== undefined && holdsTools(own, options));
    return could ? [{ unseen: options }] : [];
  }
  return literal.getProperties().flatMap((p) => {
    if (Node.isSpreadAssignment(p)) return optionValues(p.getExpression(), key, undefined, depth + 1);
    return keyOf(p) === key ? [{ value: Node.isPropertyAssignment(p) ? p.getInitializerOrThrow() : p }] : [];
  });
}

/** The tools in a collection; for `toolHandlers`, each entry is the handler itself. */
function listedTools(collection: Node, framework: string, handlers: boolean): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  const { entries, unlisted } = listing(collection, 0);
  for (const { site, key, value } of entries) {
    const definition = handlers ? undefined : objectLiteralOf(value);
    if (definition) {
      const d = nestedDefinition(definition);
      if (isDefinition(d)) out.push({ name: key ?? nameProperty(d) ?? "tool", framework, site, handler: definitionHandler(d) });
      continue;
    }
    if (!handlers && madeByFramework(value, 0)) continue;
    // A function given as the tool is its handler.
    const named = unwrapExpression(value);
    if (handlers || isCallable(value.getType())) out.push({ name: key ?? (Node.isIdentifier(named) ? named.getText() : "tool"), framework, site, handler: value });
    else if (isTool(value.getType(), value, true)) out.push(unlistedTool(value, framework, key));
  }
  for (const node of unlisted) if (holdsTools(node.getType(), node)) out.push(unlistedTool(node, framework));
  return out;
}

function unlistedTool(site: Node, framework: string, key?: string): ToolRegistration {
  return { name: key ?? "*", framework, site, handler: undefined, unlisted: true };
}

/** A collection's entries: an array's elements, a record's properties, with what's spread into them, and what's added to a constant later. */
function listing(collection: Node, depth: number, root = collection): Listing {
  const out: Listing = { entries: [], unlisted: [] };
  const merge = (more: Listing) => {
    out.entries.push(...more.entries);
    out.unlisted.push(...more.unlisted);
  };
  // Collections spread into each other in a loop end here, reported where they were given.
  if (depth > 8) return { entries: [], unlisted: [root] };
  const n = unwrapExpression(collection);
  if (Node.isArrayLiteralExpression(n)) {
    for (const element of n.getElements()) {
      if (Node.isSpreadElement(element)) merge(listing(element.getExpression(), depth + 1, root));
      else if (!Node.isOmittedExpression(element)) out.entries.push({ site: element, value: element });
    }
    return out;
  }
  if (Node.isObjectLiteralExpression(n)) {
    for (const p of n.getProperties()) {
      if (Node.isSpreadAssignment(p)) merge(listing(p.getExpression(), depth + 1, root));
      else out.entries.push({ site: p, key: keyOf(p), value: Node.isPropertyAssignment(p) ? p.getInitializerOrThrow() : p });
    }
    return out;
  }
  const constant = constantOf(n);
  const initializer = constant?.getInitializer();
  if (!constant || !initializer) return { entries: [], unlisted: [collection] };
  merge(listing(initializer, depth + 1, root));
  merge(laterEntries(constant, depth, root));
  return out;
}

/** Methods that add to a list, whose arguments are entries. */
const ADDING = new Set(["push", "unshift"]);
/** Methods that can put something in a list without saying what. */
const INSERTING = new Set(["splice", "fill", "copyWithin"]);
/** Functions that change their first argument in ways that can't be read. */
const CHANGING = new Set(["Object.assign", "Object.defineProperty", "Object.defineProperties", "Reflect.set", "Reflect.defineProperty"]);

/**
 * What's added to a constant's record or list after it's created: `tools.shell = {...}`,
 * `tools[name] = ...`, `list.push(...)`. Other changes (`Object.assign(tools, more)`,
 * `splice`, `tools.shell.execute = run`) can't be listed. A function the constant is passed
 * to could change it too; that isn't followed.
 */
function laterEntries(constant: VariableDeclaration, depth: number, root: Node): Listing {
  const out: Listing = { entries: [], unlisted: [] };
  for (const reference of constant.findReferencesAsNodes()) {
    const parent = reference.getParentOrThrow();
    if (Node.isCallExpression(parent) && parent.getArguments()[0] === reference && CHANGING.has(unwrapExpression(parent.getExpression()).getText())) {
      out.unlisted.push(parent);
      continue;
    }
    // The members it reaches: `tools.shell`, `tools["shell"].execute`.
    let top: PropertyAccessExpression | ElementAccessExpression | undefined;
    let members = 0;
    for (let p = parent; (Node.isPropertyAccessExpression(p) || Node.isElementAccessExpression(p)) && p.getExpression() === (top ?? reference); p = p.getParentOrThrow()) {
      top = p;
      members++;
    }
    if (!top) continue;
    const use = top.getParentOrThrow();
    if (Node.isBinaryExpression(use) && use.getLeft() === top && isAssignment(use)) {
      // `tools.shell = {...}` adds an entry; `tools.shell.execute = run` changes one.
      const key = Node.isPropertyAccessExpression(top) ? top.getName() : literalString(top.getArgumentExpression());
      if (members === 1 && use.getOperatorToken().getKind() === SyntaxKind.EqualsToken) out.entries.push({ site: use, key, value: use.getRight() });
      else out.unlisted.push(use);
    } else if (Node.isCallExpression(use) && use.getExpression() === top && Node.isPropertyAccessExpression(top)) {
      // Calling an entry, or a method that reads, changes nothing.
      if (members > 1) continue;
      if (ADDING.has(top.getName())) {
        for (const arg of use.getArguments()) {
          if (Node.isSpreadElement(arg)) {
            const added = listing(arg.getExpression(), depth + 1, root);
            out.entries.push(...added.entries);
            out.unlisted.push(...added.unlisted);
          } else out.entries.push({ site: arg, value: arg });
        }
      } else if (INSERTING.has(top.getName())) out.unlisted.push(use);
    }
  }
  return out;
}

function isAssignment(binary: BinaryExpression): boolean {
  const operator = binary.getOperatorToken().getKind();
  return operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
}

/** The OpenAI SDK's chat tools nest the definition: `{ type: "function", function: { name, parameters, function } }`. */
function nestedDefinition(definition: ObjectLiteralExpression): ObjectLiteralExpression {
  const inner = definition.getProperties().find((p) => keyOf(p) === "function");
  const nested = inner && Node.isPropertyAssignment(inner) ? objectLiteralOf(inner.getInitializerOrThrow()) : undefined;
  return nested ?? definition;
}

/**
 * A plain object that defines a tool the framework runs: it has a handler key (or a key that
 * can't be read, holding a function), or a definition spread in that has one. Schema-only
 * definitions (handled by the app) don't.
 */
function isDefinition(definition: ObjectLiteralExpression): boolean {
  return definitionHandler(definition) !== undefined || definition.getProperties().some((p) => !Node.isSpreadAssignment(p) && FUNCTION_KEYS.has(keyOf(p) ?? ""));
}

/**
 * A value a framework built, so registered where it's made, or a tool's name: a tool factory's
 * result (`tool({...})`, `new ShellTool()`), what a function of yours returns when every
 * `return` gives one, a string, or a value whose type the framework declares (a parameter
 * typed as its `Tool`). A plain object built some other way isn't.
 */
function madeByFramework(value: Node, depth: number): boolean {
  const n = unwrapExpression(value);
  const type = n.getType();
  if (type.isString() || type.isStringLiteral()) return true;
  if (depth > 8) return false;
  if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
    if (isRegistration(n)) return true;
    const returns = firstPartyReturns(n);
    if (returns) return returns.length > 0 && returns.every((r) => madeByFramework(r, depth + 1));
  }
  const constant = constantOf(n);
  if (constant?.hasInitializer()) return madeByFramework(constant.getInitializerOrThrow(), depth + 1);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  if (declaration && aiFramework(packageOf(declaration)) !== undefined) return true;
  // An instance of your own subclass of a framework's tool class.
  return declaration !== undefined && (Node.isClassDeclaration(declaration) || Node.isClassExpression(declaration)) && frameworkToolBase(declaration) !== undefined;
}

/** What a call to a function of your own can return, or undefined when it isn't one. */
function firstPartyReturns(call: CallExpression | NewExpression): Node[] | undefined {
  if (Node.isNewExpression(call)) return undefined;
  // The declaration of the signature called: a function, arrow function, or method.
  const fn = resolvedDeclaration(call);
  if (!fn || isThirdParty(fn) || !(Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn))) return undefined;
  const body = fn.getBody();
  if (!body) return undefined;
  if (!Node.isBlock(body)) return [body];
  const returns: Node[] = [];
  body.forEachDescendant((d, traversal) => {
    if (Node.isFunctionLikeDeclaration(d) || Node.isClassDeclaration(d) || Node.isClassExpression(d)) traversal.skip();
    else if (Node.isReturnStatement(d)) {
      const expression = d.getExpression();
      if (expression) returns.push(expression);
    }
  });
  return returns;
}

/**
 * Whether a value of this type could be a tool a framework runs: a function (a handler
 * itself), or an object with a function-valued handler key, directly or in the OpenAI SDK's
 * nested `function`. A type that says nothing (any, unknown) could be, when `unknownCould`.
 */
function isTool(type: Type, at: Node, unknownCould: boolean): boolean {
  if (type.isAny() || type.isUnknown()) return unknownCould;
  if (type.isUnion() || type.isIntersection()) return parts(type).some((t) => isTool(t, at, false));
  if (isCallable(type)) return true;
  if (!type.isObject()) return false;
  return type.getProperties().some((p) => {
    const t = p.getTypeAtLocation(at);
    if (FUNCTION_KEYS.has(p.getName()) && isCallable(t)) return true;
    if (IMPLEMENTATION_KEYS.has(p.getName()) && t.isObject()) return true;
    return p.getName() === "function" && !isCallable(t) && t.getProperties().some((q) => FUNCTION_KEYS.has(q.getName()) && isCallable(q.getTypeAtLocation(at)));
  });
}

/** A union's or an intersection's members. */
function parts(type: Type): Type[] {
  return type.isUnion() ? type.getUnionTypes() : type.getIntersectionTypes();
}

/** Whether a collection of this type (a list, or a record) could hold a tool a framework runs. */
function holdsTools(type: Type, at: Node, unknownCould = true, depth = 0): boolean {
  if (type.isAny() || type.isUnknown()) return unknownCould;
  if (depth > 3) return false;
  if (type.isUnion() || type.isIntersection()) return parts(type).some((t) => holdsTools(t, at, false, depth));
  if (isTool(type, at, false)) return true;
  const element = type.getArrayElementType() ?? type.getNumberIndexType() ?? type.getStringIndexType();
  // (A tuple's elements are its number index type.)
  if (element) return holdsTools(element, at, false, depth + 1);
  // A record of tools: `{ shell: {...}, weather }`.
  return type.isObject() && type.getProperties().some((p) => isTool(p.getTypeAtLocation(at), at, false));
}

/**
 * An object literal, or a constant that holds one (`const tools = {...}; generateText({ tools })`).
 * Constants that refer to each other end the search instead of looping.
 */
function objectLiteralOf(node: Node | undefined, depth = 0): ObjectLiteralExpression | undefined {
  if (!node || depth > 8) return undefined;
  const n = unwrapExpression(node);
  if (Node.isObjectLiteralExpression(n)) return n;
  return objectLiteralOf(constantOf(n)?.getInitializer(), depth + 1);
}

/** The first-party `const` a name (or a shorthand, `{ tools }`) refers to, if it is one. */
function constantOf(node: Node): VariableDeclaration | undefined {
  const symbol = Node.isShorthandPropertyAssignment(node) ? node.getValueSymbol() : node.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  const isConst = declaration && Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
  return isConst && !isThirdParty(declaration) ? declaration : undefined;
}

/** `new ShellTool()` where ShellTool is your class extending a framework's tool class (LangChain's `StructuredTool`). */
function toolSubclass(call: NewExpression): ToolRegistration | undefined {
  const cls = classOf(call.getExpression());
  if (!cls || isThirdParty(cls)) return undefined;
  const chain = firstPartyChain(cls);
  const base = frameworkToolBase(chain.at(-1));
  if (!base) return undefined;
  const framework = aiFramework(packageOf(base))!;
  // The whole class: LangChain runs `_call` through `invoke`, but a subclass can override
  // `invoke` (or anything else the framework calls), so any of its methods could be what runs.
  // Its `name = "..."` field, else the class's name as written.
  const name = chain.map((c) => literalString(c.getProperty("name")?.getInitializer())).find((n) => n !== undefined);
  return { name: name ?? call.getExpression().getText(), framework, site: call, handler: cls };
}

/** The class an expression names: a class declaration, or a constant holding a class expression. */
function classOf(expression: Node): ClassDeclaration | ClassExpression | undefined {
  const symbol = expression.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  const cls = declaration && Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : declaration;
  return cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) ? cls : undefined;
}

/** A class and its first-party base classes, nearest first. */
function firstPartyChain(cls: ClassDeclaration | ClassExpression): (ClassDeclaration | ClassExpression)[] {
  const chain = [cls];
  for (let base = baseClassOf(cls); base && !isThirdParty(base) && !chain.includes(base); base = baseClassOf(base)) chain.push(base);
  return chain;
}

/**
 * The class a class extends, from its `extends` clause. (ts-morph's `getBaseClass()` finds
 * nothing for a class expression, whose type is its constructor's.)
 */
function baseClassOf(cls: ClassDeclaration | ClassExpression): ClassDeclaration | ClassExpression | undefined {
  const heritage = cls.getExtends();
  return heritage && classOf(heritage.getExpression());
}

/** The first of a class's bases that is a framework's tool class (`StructuredTool`, `Tool`), if any. */
function frameworkToolBase(cls: ClassDeclaration | ClassExpression | undefined): ClassDeclaration | ClassExpression | undefined {
  const seen = new Set<Node>();
  for (let base = cls && baseClassOf(cls); base && !seen.has(base); base = baseClassOf(base)) {
    seen.add(base);
    if (TOOL_CLASS.test(String(base.getName())) && aiFramework(packageOf(base)) !== undefined) return base;
  }
  return undefined;
}

function isThirdParty(node: Node): boolean {
  return node.getSourceFile().isDeclarationFile() || isInNodeModules(node.getSourceFile());
}

/**
 * A literal first argument when it's the tool's name (MCP's `registerTool(name, ...)`, but not
 * `fileSearchTool(vectorStoreIds)`), else a `name` (or Mastra's `id`) property, else what the
 * result is assigned to.
 */
function toolName(call: CallExpression | NewExpression): string {
  const args = call.getArguments();
  // The call resolved to a framework's declaration, so it has a signature.
  const first = call.getProject().getTypeChecker().getResolvedSignature(call)!.getParameters()[0];
  const literal = /name$/i.test(String(first?.getName())) ? literalString(args[0]) : undefined;
  if (literal !== undefined) return literal;
  for (const arg of args) {
    const definition = objectLiteralOf(arg);
    const value = definition && nameProperty(definition);
    if (value !== undefined) return value;
  }
  const holder = call.getParent();
  if (holder && (Node.isPropertyAssignment(holder) || Node.isVariableDeclaration(holder))) return holder.getName();
  return "tool";
}

function nameProperty(definition: ObjectLiteralExpression): string | undefined {
  for (const key of ["name", "id"]) {
    const p = definition.getProperties().find((q) => keyOf(q) === key);
    const value = p && Node.isPropertyAssignment(p) ? literalString(p.getInitializer()) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

// --- what a handler reaches --------------------------------------------------

export interface ReachContext {
  units: ReadonlyMap<Node, Unit>;
  reach: Reach;
  edgesFrom: ReadonlyMap<Unit, readonly Edge[]>;
}

/**
 * What the model can trigger through a tool: everything its handler reaches. A handler
 * that's a unit (a named function, a method) reaches what that unit reaches. An inline
 * callback isn't a unit: its uses and calls are charged to the code around it, so those
 * inside its body count. An object or class reaches what its methods do. A handler that
 * can't be followed (a parameter, say) could be anything.
 */
export function handlerReach(tool: ToolRegistration, ctx: ReachContext): Set<string> {
  const out = new Set<string>();
  if (tool.hosted) {
    for (const options of tool.hosted) callbackReach(options, ctx, out);
    return out;
  }
  if (!tool.handler) return out.add(UNVERIFIABLE);
  valueReach(tool.handler, ctx, out, 0);
  // A built-in tool can be given a factory (`computer: () => new LocalComputer()`, or
  // `{ create }`): the framework then calls the methods of what it builds.
  const value = Node.isPropertyAssignment(tool.handler) && IMPLEMENTATION_KEYS.has(tool.handler.getName()) ? tool.handler.getInitializer() : undefined;
  if (value) productReach(value, ctx, out);
  return out;
}

function valueReach(node: Node, ctx: ReachContext, out: Set<string>, depth: number): void {
  // Values that refer to each other in a loop end here: what they run can't be told.
  if (depth > 8) {
    out.add(UNVERIFIABLE);
    return;
  }
  const n = unwrapExpression(node);

  // A class: everything in it, and in its own base classes, could be what the framework runs.
  if (Node.isClassDeclaration(n) || Node.isClassExpression(n)) {
    for (const c of firstPartyChain(n)) {
      addUnit(constructorUnitNode(c), ctx, out);
      c.forEachDescendant((d) => void addUnit(d, ctx, out));
    }
    return;
  }
  // A property of a definition: its value (or, for a function-valued property, the property itself).
  if (Node.isPropertyAssignment(n)) return addUnit(n, ctx, out) ? undefined : valueReach(n.getInitializerOrThrow(), ctx, out, depth + 1);
  if (Node.isShorthandPropertyAssignment(n)) return valueReach(n.getNameNode(), ctx, out, depth + 1);
  if (addUnit(n, ctx, out) || addUnit(unitNodeForDeclaration(n), ctx, out)) return;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
    inline(n, ctx, out);
    return;
  }
  if (Node.isObjectLiteralExpression(n)) {
    for (const p of n.getProperties()) {
      // What's spread in comes from elsewhere. Of the rest, the framework calls the functions.
      if (Node.isSpreadAssignment(p)) out.add(UNVERIFIABLE);
      else if (!addUnit(p, ctx, out) && p.getType().getCallSignatures().length > 0) valueReach(p, ctx, out, depth + 1);
    }
    return;
  }
  // An instance: of your class, what its methods reach; of a library's, methods that can't be seen.
  if (Node.isNewExpression(n)) {
    const cls = classOf(n.getExpression());
    if (cls && !isThirdParty(cls)) valueReach(cls, ctx, out, depth + 1);
    else out.add(UNVERIFIABLE);
    return;
  }
  if (Node.isIdentifier(n) || Node.isPropertyAccessExpression(n)) {
    const parent = n.getParent();
    const symbol = parent && Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === n ? parent.getValueSymbol() : n.getSymbol();
    const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
    const targets = symbol ? unitNodesForSymbol(resolveAlias(symbol)) : [];
    const constant = constantOf(n);
    if (targets.length > 0) targets.forEach((t) => addUnit(t, ctx, out));
    else if (constant?.hasInitializer()) valueReach(constant.getInitializerOrThrow(), ctx, out, depth + 1);
    // A library's function: what adapters say about using it. A library's object has methods that can't be seen.
    else if (declaration && isThirdParty(declaration) && n.getType().getCallSignatures().length > 0) inline(n, ctx, out);
    else out.add(UNVERIFIABLE);
    return;
  }
  // Anything else (a call's result, a computed value) could be anything.
  out.add(UNVERIFIABLE);
}

/**
 * What the callbacks among a hosted tool's options reach (`onApproval`, which runs here when the
 * provider asks). Options that can't be seen (a spread, a parameter) could hold one, when their
 * type allows a function.
 */
function callbackReach(options: Node, ctx: ReachContext, out: Set<string>): void {
  const literal = objectLiteralOf(options);
  if (!literal) {
    if (hasCallableProperty(options.getType(), options)) out.add(UNVERIFIABLE);
    return;
  }
  for (const p of literal.getProperties()) {
    if (Node.isSpreadAssignment(p)) callbackReach(p.getExpression(), ctx, out);
    else if (isCallable(p.getType())) valueReach(p, ctx, out, 0);
  }
}

/** An object type with a function-valued property of its own (not a method every array or object has). */
function hasCallableProperty(type: Type, at: Node): boolean {
  if (type.isAny() || type.isUnknown()) return true;
  const parts = type.isUnion() ? type.getUnionTypes() : [type];
  return parts.some(
    (t) => (t.isObject() || t.isIntersection()) && t.getProperties().some((p) => isCallable(p.getTypeAtLocation(at)) && !p.getDeclarations().every((d) => isStandardLibrary(d.getSourceFile()))),
  );
}

/** TypeScript's own lib files (lib.es5.d.ts, lib.dom.d.ts, ...). */
function isStandardLibrary(file: SourceFile): boolean {
  return /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(file.getFilePath());
}

function isCallable(type: Type): boolean {
  return type.getCallSignatures().length > 0 || type.getUnionTypes().some((t) => t.getCallSignatures().length > 0);
}

/** Adds what a unit reaches, if `unitNode` is one. */
function addUnit(unitNode: Node | undefined, ctx: ReachContext, out: Set<string>): boolean {
  const unit = unitNode && ctx.units.get(unitNode);
  if (unit) for (const key of ctx.reach.get(unit)!.keys()) out.add(key);
  return unit !== undefined;
}

/**
 * What the object a factory builds can reach, for a factory function or a `{ create }`
 * provider: the methods of its (awaited) return type. A method declared only by a library's
 * interface (the return type says `Computer`), or a product of unknown type, can't be seen.
 */
function productReach(value: Node, ctx: ReachContext, out: Set<string>): void {
  const type = value.getType();
  const create = type.getProperty("create")?.getTypeAtLocation(value);
  for (const signature of [...type.getCallSignatures(), ...(create?.getCallSignatures() ?? [])]) {
    const returned = signature.getReturnType();
    const product = returned.getSymbol()?.getName() === "Promise" ? returned.getTypeArguments()[0]! : returned;
    if (!product.isObject()) out.add(UNVERIFIABLE);
    for (const property of product.getProperties()) {
      if (property.getTypeAtLocation(value).getCallSignatures().length === 0) continue;
      const implementations = property.getDeclarations().map(unitNodeForDeclaration).filter((n): n is Node => n !== undefined);
      if (implementations.length === 0) out.add(UNVERIFIABLE);
      for (const n of implementations) addUnit(n, ctx, out);
    }
  }
}

/** What code inside `node` reaches when it belongs to the unit around it: its uses, and the calls it makes. */
function inline(node: Node, ctx: ReachContext, out: Set<string>): void {
  // Handlers are in checked files, where every node has a unit around it.
  const unit = ctx.units.get(enclosingUnitNode(node))!;
  const sf = node.getSourceFile();
  const start = sf.getLineAndColumnAtPos(node.getStart());
  const end = sf.getLineAndColumnAtPos(node.getEnd());
  const inside = (p: { line: number; column: number }) =>
    (p.line > start.line || (p.line === start.line && p.column >= start.column)) && (p.line < end.line || (p.line === end.line && p.column <= end.column));
  for (const use of unit.uses) if (inside(use)) out.add(formatCapability(use.capability));
  for (const edge of ctx.edgesFrom.get(unit) ?? []) if (inside(edge)) for (const key of ctx.reach.get(edge.to)!.keys()) out.add(key);
}
