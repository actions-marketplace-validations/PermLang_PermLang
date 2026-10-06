// Tools given to AI models. A function registered as a tool (MCP, the Vercel AI SDK,
// OpenAI Agents, LangChain, ...) runs when the model decides to call it, and the model
// does what its input says, so whoever controls that input can trigger it. Prompt
// injection then reaches whatever the tool reaches. This finds the registrations and
// their handlers, and works out what each handler reaches.

import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type NewExpression,
  type ObjectLiteralExpression,
  type SourceFile,
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
  /** The tool runs at the model provider (a hosted web search, say): no code here runs for it. */
  hosted?: boolean;
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
];

/** The framework a package belongs to, as reported, or undefined if it isn't one. */
export function aiFramework(pkg: string | undefined): string | undefined {
  if (pkg === undefined) return undefined;
  const family = FAMILIES.find((f) => f.matches(pkg));
  return family && (family.name ?? pkg);
}

/** Functions that create or register a tool, including OpenAI Agents' built-in tools that run here. */
const TOOL_FUNCTION = /^(tool|registerTool|createTool|dynamicTool|betaTool|betaZodTool|zodTool|FunctionTool|shellTool|computerTool|applyPatchTool)$/;
/** Classes, and the types factories return (`ProviderDefinedTool`, `FunctionTool`), that are tools. */
const TOOL_CLASS = /Tool$/;
/** Where a tool definition keeps the function that runs. */
const FUNCTION_KEYS = new Set(["execute", "run", "func", "handler", "invoke", "callback", "fn"]);
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
  const out = plainTools(args, framework);
  const name = calleeName(call, declaration);

  // MCP's low-level API: one handler serves every tool call.
  if (name === "setRequestHandler") {
    if (servesToolCalls(args[0])) out.push({ name: "*", framework, site: call, handler: lastFunction(args) });
    return out;
  }
  if (isToolFactory(call, name)) out.push({ name: toolName(call), framework, site: call, ...handlerOf(call) });
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

/**
 * A call that makes a tool: by name (`tool`, `registerTool`, ...), a class named `...Tool` or
 * extending one (LangChain's prebuilt `Calculator` extends `Tool`), or a factory that returns a
 * tool type, which covers provider tools such as `anthropic.tools.bash_20250124(...)` and
 * LlamaIndex's `FunctionTool.from(...)`.
 */
function isToolFactory(call: CallExpression | NewExpression, name: string | undefined): boolean {
  if (Node.isNewExpression(call)) return TOOL_CLASS.test(String(name)) || frameworkToolBase(classOf(call.getExpression())) !== undefined;
  return TOOL_FUNCTION.test(String(name)) || TOOL_CLASS.test(String(frameworkTypeName(call)));
}

/** The name of the type a call returns, when an AI framework declares it: a type of your own doesn't count. */
function frameworkTypeName(call: CallExpression | NewExpression): string | undefined {
  const type = call.getType();
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const declaration = symbol?.getDeclarations()[0];
  return declaration && aiFramework(packageOf(declaration)) !== undefined ? symbol!.getName() : undefined;
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
  return { handler: undefined, hosted: runsAtProvider(call) };
}

function lastFunction(args: readonly Node[]): Node | undefined {
  return [...args].reverse().find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a) || a.getType().getCallSignatures().length > 0);
}

/**
 * A definition's handler property. A property named like one that isn't a function (MCP's
 * schema `{ run: "boolean" }`) isn't it; one typed `any` (`execute: execSync as any`) is a
 * second choice, after real functions.
 */
function definitionHandler(definition: ObjectLiteralExpression): Node | undefined {
  let untyped: Node | undefined;
  for (const p of definition.getProperties()) {
    if (Node.isSpreadAssignment(p)) continue;
    const key = p.getName();
    if (IMPLEMENTATION_KEYS.has(key)) return p;
    if (!FUNCTION_KEYS.has(key)) continue;
    // A method, or a property or shorthand whose value is a function.
    const type = p.getType();
    if (type.getCallSignatures().length > 0) return p;
    if (type.isAny()) untyped ??= p;
  }
  return untyped;
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

/** Tools written as plain objects in a `tools` option: `generateText({ tools: { shell: { execute } } })`. */
function plainTools(args: readonly Node[], framework: string): ToolRegistration[] {
  const out: ToolRegistration[] = [];
  for (const arg of args) {
    const property = objectLiteralOf(arg)?.getProperty("tools");
    if (!property) continue;
    // A list (`[{ name, run }]`) or a record (`{ shell: { execute } }`, spreads included). A
    // list or record passed from elsewhere (a parameter) isn't followed.
    const value = unwrapExpression(valueNode(property));
    const entries = Node.isArrayLiteralExpression(value)
      ? value.getElements().map((element) => ({ site: element, definition: objectLiteralOf(element), key: undefined }))
      : recordEntries(objectLiteralOf(value));
    for (const { site, definition, key } of entries) {
      if (definition && isDefinition(definition)) out.push({ name: key ?? nameProperty(definition) ?? "tool", framework, site, handler: definitionHandler(definition) });
    }
  }
  return out;
}

/** What a property holds: its initializer, or, for a shorthand (`{ tools }`), the property itself. */
function valueNode(property: Node): Node {
  return Node.isPropertyAssignment(property) ? property.getInitializerOrThrow() : property;
}

/** A record's entries, with those of the records spread into it (`{ ...shared, shell }`). */
function recordEntries(record: ObjectLiteralExpression | undefined, depth = 0): { site: Node; definition: ObjectLiteralExpression | undefined; key: string }[] {
  // Records spread into each other in a loop end here.
  if (!record || depth > 8) return [];
  return record.getProperties().flatMap((entry) =>
    Node.isSpreadAssignment(entry)
      ? recordEntries(objectLiteralOf(entry.getExpression()), depth + 1)
      : [{ site: entry, definition: objectLiteralOf(valueNode(entry)), key: entry.getName() }],
  );
}

/** A plain object that defines a tool the framework runs: it has a handler key. Schema-only definitions (handled by the app) don't. */
function isDefinition(definition: ObjectLiteralExpression): boolean {
  return definition.getProperties().some((p) => !Node.isSpreadAssignment(p) && FUNCTION_KEYS.has(p.getName()));
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
  const isConst = declaration && Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === "const";
  return isConst && !isThirdParty(declaration) ? (declaration as VariableDeclaration) : undefined;
}

/** `new ShellTool()` where ShellTool is your class extending a framework's tool class (LangChain's `StructuredTool`). */
function toolSubclass(call: NewExpression): ToolRegistration | undefined {
  const cls = classOf(call.getExpression());
  if (!cls || isThirdParty(cls)) return undefined;
  const chain = firstPartyChain(cls);
  const base = frameworkToolBase(chain.at(-1)!);
  if (!base) return undefined;
  const framework = aiFramework(packageOf(base))!;
  // LangChain runs `_call`; for other frameworks, any method could be what runs.
  const run = chain.flatMap((c) => c.getMethods()).find((m) => m.getName() === "_call" && m.hasBody());
  // Its `name = "..."` field, else the class's name as written.
  const name = chain.map((c) => literalString(c.getProperty("name")?.getInitializer())).find((n) => n !== undefined);
  return { name: name ?? call.getExpression().getText(), framework, site: call, handler: run ?? cls };
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
    const p = definition.getProperty(key);
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
  if (tool.hosted) return out;
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
