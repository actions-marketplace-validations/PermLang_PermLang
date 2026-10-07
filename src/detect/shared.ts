// Helpers shared by the detectors.

import {
  Node,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type ObjectLiteralExpression,
  type Signature,
  type Symbol as MorphSymbol,
  type Identifier,
  type SourceFile,
  type TaggedTemplateExpression,
  type Type,
} from "ts-morph";
import type { Capability } from "../capability.js";
import { emitsCommonJs } from "./module-format.js";

export type CallLike = CallExpression | NewExpression | TaggedTemplateExpression;

export interface CapabilityUse {
  capability: Capability;
  /** The code as written, shortened for messages. */
  call: string;
  /** How messages describe the use: "calls fetch(...)", "reads process.env.X", "uses fetch as a value". */
  verb: "calls" | "reads" | "uses";
}

export function resolveAlias(symbol: MorphSymbol): MorphSymbol {
  return symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
}

export function argumentsOf(call: CallLike): Node[] {
  return Node.isTaggedTemplateExpression(call) ? [] : call.getArguments();
}

export function callText(call: CallLike): string {
  if (Node.isTaggedTemplateExpression(call)) return `${call.getTag().getText()}\`...\``;
  const args = call.getArguments();
  const first = args[0]?.getText() ?? "";
  const shown = (first.length > 60 ? `${first.slice(0, 57)}...` : first) + (args.length > 1 ? ", ..." : "");
  const prefix = Node.isNewExpression(call) ? "new " : "";
  return `${prefix}${call.getExpression().getText()}(${shown})`.replace(/\s+/g, " ");
}

/**
 * A string argument's value when it is known statically: a literal, a `const`
 * holding one (also as a `{ name }` shorthand), a string enum member, or a
 * property of an `as const` object.
 * Undefined when it is computed.
 *
 * The value is traced, never taken from the type: the checker doesn't require
 * code to type-check, and `u as "https://good.example/"` has a literal type
 * without a literal value.
 *
 * Enums and `as const` objects can still be changed at runtime, so a value read
 * from one that the program writes to anywhere is unknown (see isWritten).
 */
export function literalString(arg: Node | undefined, depth = 0): string | undefined {
  if (!arg || depth > 8) return undefined;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralValue();
  if (!Node.isIdentifier(arg) && !Node.isPropertyAccessExpression(arg) && !Node.isShorthandPropertyAssignment(arg)) return undefined;

  const symbol = Node.isShorthandPropertyAssignment(arg)
    ? arg.getValueSymbol()
    : (Node.isPropertyAccessExpression(arg) ? arg.getNameNode() : arg).getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (!declaration) return undefined;
  if (Node.isEnumMember(declaration)) {
    return isWritten(declaration.getParent().getNameNode()) ? undefined : literalString(declaration.getInitializer(), depth + 1);
  }
  if (Node.isVariableDeclaration(declaration)) {
    const name = declaration.getNameNode();
    const fixed = isConst(declaration) && Node.isIdentifier(name) && !holderWritten(name);
    return fixed ? literalString(declaration.getInitializer(), depth + 1) : undefined;
  }
  if (!Node.isPropertyAssignment(declaration)) return undefined;
  const holder = constObjectHolder(declaration);
  return holder && !isWritten(holder) ? literalString(declaration.getInitializer(), depth + 1) : undefined;
}

function isConst(declaration: Node): boolean {
  return Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === "const";
}

/** The name of the `const X` holding `{ ... } as const` that a property belongs to (possibly nested), if it is one. */
function constObjectHolder(property: Node): Identifier | undefined {
  let node = property.getParent();
  while (node && Node.isObjectLiteralExpression(node)) {
    const parent = node.getParent();
    if (parent && Node.isAsExpression(parent) && parent.getTypeNode()?.getText() === "const") {
      const holder = parent.getParent();
      const name = Node.isVariableDeclaration(holder) && isConst(holder) ? holder.getNameNode() : undefined;
      return Node.isIdentifier(name) ? name : undefined;
    }
    node = parent && Node.isPropertyAssignment(parent) ? parent.getParent() : undefined;
  }
  return undefined;
}

// --- Fixed values the program changes --------------------------------------------
//
// An `as const` object's properties and an enum's members are readonly only to the
// type checker: `Object.assign(CONFIG, { url })` or `(Endpoint as any).Url = url`
// changes them at runtime. So every reference to the object, anywhere in the
// program, is checked for a write: an assignment, `delete`, `++`/`--`, or
// destructuring into one of its members (`CONFIG.url = ...`, `CONFIG.a.b = ...`);
// a cast (after which anything can happen to it); being the target of one of
// WRITING_FUNCTIONS, matched by the declaration it resolves to however it's reached
// (`Object["assign"]`, `const { assign } = Object`, `globalThis.Object.assign`,
// `.call`, `.apply`, `Reflect.apply`, or a spread list of arguments); or, for an
// `as const` object, a method of its own that writes to `this`.
//
// A plain exported `const` is fixed only as long as the object holding the exports
// is: a namespace (`namespace Api { export const url = "..." }` is a property of
// `Api`), or, in a file compiled to CommonJS, the `exports` object that a namespace
// import in another file reaches (`import * as config from "./config"`). Writes to
// that object count for every constant it holds, and so for enums and `as const`
// objects exported the same way.
//
// Not followed: the object stored in another variable or passed to a function
// that then writes to it, and a CommonJS module's exports written through
// `require()`, `module.exports`, or a namespace re-exported from another file.
// Those are known limits.

// Per program, so that a project edited and checked again (through the library API) is read afresh.
const written = new WeakMap<object, WeakMap<Node, boolean>>();

// Functions that change their first argument's properties, by the interface or namespace that declares them.
const WRITING_FUNCTIONS: Record<string, readonly string[]> = {
  ObjectConstructor: ["assign", "defineProperty", "defineProperties", "setPrototypeOf"],
  Reflect: ["set", "defineProperty", "deleteProperty", "setPrototypeOf"],
};

/** Whether the program may change an enum or `as const` object, named `name`, after it's created. */
function isWritten(name: Identifier): boolean {
  return cachedWrite(name, () => name.findReferencesAsNodes().some((reference) => writesThrough(reference)) || writesItself(name) || holderWritten(name));
}

function cachedWrite(key: Node, compute: () => boolean): boolean {
  const program = key.getProject().getProgram().compilerObject;
  const cache = written.get(program) ?? new WeakMap<Node, boolean>();
  written.set(program, cache);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // A namespace's members are checked through the namespace, which is never its own member.
  cache.set(key, false);
  const result = compute();
  cache.set(key, result);
  return result;
}

/**
 * An `as const` object with a function of its own that writes to `this`, which is the object
 * (or an object nested in it): `set(u) { (this as any).url = u; }`, also as a getter or setter,
 * or a `function` held as a property.
 */
function writesItself(name: Identifier): boolean {
  const holder = name.getParent();
  const initializer = Node.isVariableDeclaration(holder) ? holder.getInitializer() : undefined;
  const object = initializer && unwrapExpression(initializer);
  if (!object || !Node.isObjectLiteralExpression(object)) return false;
  return object.getDescendantsOfKind(SyntaxKind.ThisKeyword).some((self) => isObjectThis(self) && writesThrough(self));
}

/**
 * Whether `this` is an object literal's: in its method or accessor, or a `function` it holds as a
 * property. `this` belongs to the nearest function that isn't an arrow, or class, so a class, a
 * function declared inside, and a function passed as a callback have one of their own.
 */
function isObjectThis(self: Node): boolean {
  const owner = self.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isMethodDeclaration(a) ||
    Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a) || Node.isClassDeclaration(a) || Node.isClassExpression(a));
  const parent = owner?.getParent();
  return Node.isObjectLiteralExpression(parent) || (Node.isFunctionExpression(owner) && Node.isPropertyAssignment(parent));
}

/**
 * Whether the object that holds an exported declaration (a `const`, an enum, a namespace) can be
 * written: its namespace, or, in a file compiled to CommonJS, the `exports` object reached by a
 * namespace import in another file.
 */
function holderWritten(name: Identifier): boolean {
  const declaration = name.getParent();
  const statement = Node.isVariableDeclaration(declaration) ? declaration.getVariableStatement() : declaration;
  if (!statement || !Node.isModifierable(statement) || !statement.hasModifier(SyntaxKind.ExportKeyword)) return false;
  const container = statement.getParent();
  if (Node.isModuleBlock(container)) {
    const namespace = container.getParent();
    return Node.isModuleDeclaration(namespace) && Node.isIdentifier(namespace.getNameNode()) && isWritten(namespace.getNameNode() as Identifier);
  }
  return Node.isSourceFile(container) && exportsWritten(container);
}

/** Whether a CommonJS file's `exports` object is written through a namespace import of it. */
function exportsWritten(file: SourceFile): boolean {
  if (!emitsCommonJs(file)) return false;
  return cachedWrite(file, () => file.getReferencingNodesInOtherSourceFiles().some((reference) => {
    const name = Node.isImportDeclaration(reference) ? reference.getNamespaceImport()
      : Node.isImportEqualsDeclaration(reference) ? reference.getNameNode()
      : undefined;
    return name !== undefined && isWritten(name);
  }));
}

/** Whether one reference to an object writes to it. */
function writesThrough(reference: Node): boolean {
  let chain: Node = reference;
  const parentOfName = reference.getParent();
  // `config.CONFIG`, through a namespace import: the access is the reference.
  if (Node.isPropertyAccessExpression(parentOfName) && parentOfName.getNameNode() === reference) chain = parentOfName;
  let members = 0;
  for (let parent = chain.getParent(); parent; parent = chain.getParent()) {
    if (Node.isAsExpression(parent) || Node.isTypeAssertion(parent)) {
      if (parent.getTypeNode()?.getText() !== "const") return true;
    } else if (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) {
      if (parent.getExpression() !== chain) break;
      members++;
    } else if (!Node.isParenthesizedExpression(parent) && !Node.isNonNullExpression(parent) && !Node.isSatisfiesExpression(parent)) {
      break;
    }
    chain = parent;
  }
  if (isWritingCallTarget(chain)) return true;
  return members > 0 && isAssignedTo(chain);
}

/**
 * Whether `target` is what a writing function changes: the first argument of
 * `Object.assign(target, ...)` and the like, however the function is reached
 * (`fn.call(thisArg, target)`, `fn.bind(thisArg, target)`, `fn.apply(thisArg, [target])`,
 * `Reflect.apply(fn, thisArg, [target])`). In a list of arguments that's spread
 * (`Object.assign(...[target, source])`), or after a spread, any position could be the first.
 */
function isWritingCallTarget(target: Node): boolean {
  const argument = argumentOf(target);
  if (!argument) return false;
  const { call, index, list } = argument;
  // An unknown position (-1) could be the target's.
  const first = index <= 0;
  if (list === undefined && isWritingFunction(resolvedDeclaration(call))) return first;
  const callee = unwrapExpression(call.getExpression());
  if (Node.isPropertyAccessExpression(callee) && writes(callee.getExpression())) {
    // `fn.apply(thisArg, [target, ...])`; `fn.call(thisArg, target, ...)` and `fn.bind(thisArg, target)`.
    return callee.getName() === "apply" ? list === 1 && first : list === undefined && (index === 1 || index === -1);
  }
  // `Reflect.apply(fn, thisArg, [target, ...])`.
  return list === 2 && first && isReflectApply(call) && writes(call.getArguments()[0]!);
}

/**
 * Where an expression is given to a call: its argument index, or its index in an array literal
 * given as argument `list`. An array spread into the call (`f(...[a, b])`) stands for the
 * arguments from where it's spread. -1 when a spread before it means it could be anywhere.
 */
function argumentOf(node: Node): { call: CallExpression; index: number; list?: number } | undefined {
  const parent = node.getParent();
  if (Node.isCallExpression(parent)) {
    const at = parent.getArguments().indexOf(node);
    return at < 0 ? undefined : { call: parent, index: positionIn(parent.getArguments(), at) };
  }
  if (!Node.isArrayLiteralExpression(parent)) return undefined;
  const elements: Node[] = parent.getElements();
  const element = positionIn(elements, elements.indexOf(node));
  const list = outermost(parent);
  const holder = list.getParent();
  if (Node.isSpreadElement(holder) && Node.isCallExpression(holder.getParent())) {
    const call = holder.getParentOrThrow() as CallExpression;
    const at = positionIn(call.getArguments(), call.getArguments().indexOf(holder));
    return { call, index: at < 0 || element < 0 ? -1 : at + element };
  }
  return Node.isCallExpression(holder) ? { call: holder, index: element, list: holder.getArguments().indexOf(list) } : undefined;
}

/** A node's index among others, or -1 when a spread before it means it could be anywhere. */
function positionIn(nodes: readonly Node[], index: number): number {
  return nodes.slice(0, index).some((n) => Node.isSpreadElement(n)) ? -1 : index;
}

/** An expression with the parentheses, casts, and `!` around it. */
function outermost(node: Node): Node {
  let outer = node;
  for (let parent = outer.getParent(); parent && unwrapExpression(parent) === unwrapExpression(node); parent = outer.getParent()) outer = parent;
  return outer;
}

/** Whether a function value is one of WRITING_FUNCTIONS: `Object.assign`, or an alias of it. */
function writes(fn: Node): boolean {
  return signatureDeclarations(fn.getType().getCallSignatures()).some(isWritingFunction);
}

function isWritingFunction(declaration: Node | undefined): boolean {
  if (!declaration || !declaration.getSourceFile().isDeclarationFile()) return false;
  if (!Node.isMethodSignature(declaration) && !Node.isFunctionDeclaration(declaration)) return false;
  const name = declaration.getName();
  const container = containerName(declaration);
  return name !== undefined && container !== undefined && (WRITING_FUNCTIONS[container]?.includes(name) ?? false);
}

/** The target of an assignment, `delete`, `++`/`--`, or a destructuring assignment. */
function isAssignedTo(target: Node): boolean {
  let node = target;
  for (let parent = node.getParent(); parent; node = parent, parent = parent.getParent()) {
    if (Node.isDeleteExpression(parent)) return true;
    if (Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent)) {
      const op = parent.getOperatorToken();
      return op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken;
    }
    if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getKind();
      return parent.getLeft() === node && op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
    }
    if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) return parent.getInitializer() === node;
    // Inside a destructuring pattern on the left of `=`: `({ a: CONFIG.url } = evil)`, `[CONFIG.url] = evil`.
    const inPattern = Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) ||
      Node.isPropertyAssignment(parent) || Node.isSpreadElement(parent) || Node.isSpreadAssignment(parent);
    if (!inPattern) return false;
  }
  return false;
}

/**
 * How an object literal sets property `name`: the node that holds its value (an initializer,
 * or a `{ name }` shorthand), "absent" when the literal doesn't set it, or "unknown" when it
 * may set it in a way that can't be read. Later properties win, so a spread, a computed key,
 * or an accessor after the last plain `name: value` makes it unknown.
 */
export function propertyValue(object: ObjectLiteralExpression, name: string): Node | "absent" | "unknown" {
  const properties = object.getProperties();
  for (let i = properties.length - 1; i >= 0; i--) {
    const p = properties[i]!;
    if (Node.isSpreadAssignment(p)) return "unknown";
    const key = propertyKey(p.getNameNode());
    if (key === undefined) return "unknown";
    if (key !== name) continue;
    if (Node.isPropertyAssignment(p)) return p.getInitializerOrThrow();
    if (Node.isShorthandPropertyAssignment(p)) return p;
    return "unknown"; // a getter, setter, or method
  }
  return "absent";
}

/**
 * A property name (`a`, `"a"`, `["a"]`), or undefined for a computed key that can't be known.
 * A number is kept as written, which is enough to tell it from the names looked for.
 */
function propertyKey(name: Node): string | undefined {
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

// Several passes resolve the same calls; signature resolution is the expensive part.
// The cache lasts one check: ts-morph keeps a call's node when the code around it is
// edited, so a Project checked again after an edit would get the old answers.
let resolved = new WeakMap<Node, Node | undefined>();

/** Forgets every resolved call. checkProject calls this before it starts. */
export function clearResolutionCache(): void {
  resolved = new WeakMap();
}

/** The declaration of the signature a call resolves to: the overload, method, or call signature actually used. */
export function resolvedDeclaration(call: CallLike): Node | undefined {
  if (resolved.has(call)) return resolved.get(call);
  let declaration: Node | undefined;
  try {
    declaration = call.getProject().getTypeChecker().getResolvedSignature(call)?.getDeclaration();
  } catch {
    declaration = undefined;
  }
  resolved.set(call, declaration);
  return declaration;
}

/**
 * The declarations of signatures that have one. A class with no constructor and no base class
 * has a construct signature without one, which ts-morph can't wrap (it throws).
 */
export function signatureDeclarations(signatures: readonly Signature[]): Node[] {
  return signatures.flatMap((s) => (s.compilerSignature.declaration ? [s.getDeclaration()] : []));
}

/** `Reflect.apply(fn, thisArg, args)`, the standard library's: a call of `fn` with `args`. */
export function isReflectApply(call: CallExpression): boolean {
  const declaration = resolvedDeclaration(call);
  return Node.isFunctionDeclaration(declaration) && declaration.getName() === "apply" &&
    containerName(declaration) === "Reflect" && declaration.getSourceFile().isDeclarationFile();
}

/**
 * A global function or variable from the TypeScript lib or @types/node, such as
 * `fetch` or `eval`: declared in a .d.ts, and not inside a `declare module "x"`
 * package block (`declare global` is fine).
 */
export function isGlobalLibFunction(declaration: Node, name: string): boolean {
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return false;
  if (declaration.getName() !== name || !declaration.getSourceFile().isDeclarationFile()) return false;
  // @types/node nests some globals as `declare module "timers" { global { function setTimeout ... } }`.
  for (const a of declaration.getAncestors()) {
    if (!Node.isModuleDeclaration(a)) continue;
    if (a.getName() === "global") return true;
    if (Node.isStringLiteral(a.getNameNode())) return false;
  }
  return true;
}

/** A string argument, which setTimeout and friends evaluate as code, even when a cast hides it from the type checker. */
export function evaluatesString(arg: Node | undefined): boolean {
  if (!arg) return false;
  const inner = unwrapExpression(arg);
  const type = inner.getType();
  return (
    Node.isStringLiteral(inner) ||
    Node.isNoSubstitutionTemplateLiteral(inner) ||
    Node.isTemplateExpression(inner) ||
    type.isString() ||
    type.isStringLiteral() ||
    type.isTemplateLiteral()
  );
}

/** Whether a string can be given where `type` is expected: `string`, `any`, `unknown`, `{}`, or a union with one (lib.dom's `TimerHandler`). */
export function admitsString(type: Type, at: Node): boolean {
  const checker = at.getProject().getTypeChecker().compilerObject;
  return checker.isTypeAssignableTo(checker.getStringType(), type.compilerType);
}

/** Strips parentheses, `as`, `!`, and `satisfies` to reach the expression underneath. */
export function unwrapExpression(node: Node): Node {
  let n = node;
  while (
    Node.isParenthesizedExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isTypeAssertion(n) ||
    Node.isNonNullExpression(n) ||
    Node.isSatisfiesExpression(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

/** The name of the nearest class, interface, type alias, or namespace a declaration sits in. */
export function containerName(declaration: Node): string | undefined {
  for (const a of declaration.getAncestors()) {
    if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeAliasDeclaration(a)) return a.getName();
    if (Node.isModuleDeclaration(a)) return Node.isStringLiteral(a.getNameNode()) ? undefined : a.getName();
  }
  return undefined;
}

// The host is known only when the literal text contains the whole authority
// (userinfo, host, port): the scheme, then everything up to the first `/`, `?`,
// or `#`. `https://api.stripe.com${x}` and `https://good.example:${p}/` could
// both become any host (`p = "x@evil.example"`).
const TEMPLATE_AUTHORITY = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)[/?#]/i;

function templateHost(head: string): string | undefined {
  const authority = TEMPLATE_AUTHORITY.exec(head)?.[1];
  if (!authority) return undefined;
  try {
    return new URL(`${authority}/`).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

// Options that decide where a connection goes without naming a host: a local socket, a custom
// DNS lookup, or a custom connection. Node's http and net, axios, and others all accept them.
const REDIRECTING_OPTIONS = ["socketPath", "lookup", "createConnection"];

/**
 * The host an argument names: a URL string or template, `new URL(...)`, or an options object
 * whose `url`, `hostname`, and `host` (those it sets) all name the same literal host.
 * Undefined when it can't be known, including when an option could send the connection
 * elsewhere (a spread or computed key that could set any of them, an accessor, or one of
 * REDIRECTING_OPTIONS).
 */
export function hostOf(written: Node | undefined): string | undefined {
  if (!written) return undefined;
  const arg = unwrapExpression(written);
  const text = literalString(arg);
  if (text !== undefined) {
    try {
      return new URL(text).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isTemplateExpression(arg)) {
    return templateHost(arg.getHead().getLiteralText());
  }
  // new URL("https://host/path") or new URL("/path", "https://host"), with literal parts.
  if (Node.isNewExpression(arg) && isGlobalUrl(arg.getExpression())) {
    const [input, base] = arg.getArguments().map((a) => literalString(a));
    if (input === undefined || (arg.getArguments().length > 1 && base === undefined)) return undefined;
    try {
      return new URL(input, base).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  if (Node.isObjectLiteralExpression(arg)) {
    if (redirects(arg, REDIRECTING_OPTIONS)) return undefined;
    let host: string | undefined;
    for (const key of ["url", "hostname", "host"]) {
      const value = propertyValue(arg, key);
      if (value === "absent") continue;
      const named = value === "unknown" ? undefined : key === "url" ? hostOf(value) : hostName(value);
      if (named === undefined || (host !== undefined && named !== host)) return undefined;
      host = named;
    }
    return host;
  }
  return undefined;
}

/**
 * Where Node's http.request(input, options) connects, and https's, http.get's, and
 * ClientRequest's. Node reads `hostname` before `host` and ignores an options object's `url`.
 * After a URL or URL string, options are merged over it: their `hostname` replaces the URL's
 * host, but their `host` doesn't, because the URL sets `hostname`. (lib/_http_client.js; the
 * reference has a test of each order.)
 */
export function nodeRequestHost(args: readonly Node[], index: number): string | undefined {
  const input = args[index] && unwrapExpression(args[index]);
  if (!input) return undefined;
  if (Node.isObjectLiteralExpression(input)) {
    if (redirects(input, REDIRECTING_OPTIONS) || agentRedirects(input)) return undefined;
    const hostname = propertyValue(input, "hostname");
    // Without a hostname or host, Node connects to localhost; the reference treats that as unknown.
    return hostname === "absent" ? optionHost(input, "host") : hostname === "unknown" ? undefined : hostName(hostname);
  }
  const host = hostOf(input);
  const options = args[index + 1] && unwrapExpression(args[index + 1]);
  // No options, or a callback, leaves the URL's host; options that aren't written out could replace it.
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options)) return undefined;
  if (redirects(options, REDIRECTING_OPTIONS) || agentRedirects(options)) return undefined;
  const hostname = propertyValue(options, "hostname");
  return hostname === "absent" ? host : hostname === "unknown" ? undefined : hostName(hostname);
}

// What a socket's options can connect to instead of a host: a local socket, or an open one.
const SOCKET_REDIRECTS = ["path", "socket", ...REDIRECTING_OPTIONS];

/**
 * Where Node's net.connect and tls.connect connect: an options object's `host` (its `hostname`
 * is ignored, and a `path` is a local socket), or `connect(port, host)`. tls.connect also takes
 * `connect(port, host, options)` and merges the options over the host, so their `host` wins;
 * net ignores them. Options that set (or may set) a different host leave it unknown either way.
 */
export function nodeSocketHost(args: readonly Node[], index: number): string | undefined {
  const first = args[index] && unwrapExpression(args[index]);
  if (!first) return undefined;
  if (Node.isObjectLiteralExpression(first)) {
    return redirects(first, SOCKET_REDIRECTS) ? undefined : optionHost(first, "host");
  }
  const type = first.getType();
  if (!type.isNumber() && !type.isNumberLiteral()) return undefined; // a socket path, or options that can't be read
  const written = args[index + 1];
  const host = written && !isCallback(unwrapExpression(written)) ? hostName(written) : undefined;
  const options = args[index + 2] && unwrapExpression(args[index + 2]);
  // A callback (`connect(port, host, onConnect)`) isn't options.
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options) || redirects(options, SOCKET_REDIRECTS)) return undefined;
  return sameHost(options, host);
}

/**
 * Where Node's http2.connect(authority, options) connects: the authority's host, unless the
 * options set another. Node passes them on to net.connect or tls.connect, where their `host`
 * wins over the authority's, and a `path`, `socket`, `lookup`, or `createConnection` goes
 * somewhere else. Options that aren't written out could do any of that.
 */
export function nodeSessionHost(args: readonly Node[], index: number): string | undefined {
  const host = hostOf(args[index]);
  const options = args[index + 1] && unwrapExpression(args[index + 1]);
  if (!options || isCallback(options)) return host;
  if (!Node.isObjectLiteralExpression(options) || redirects(options, SOCKET_REDIRECTS)) return undefined;
  return sameHost(options, host);
}

/** `host`, if options merged over it leave it: they don't set `host`, or set the same one. */
function sameHost(options: ObjectLiteralExpression, host: string | undefined): string | undefined {
  const value = propertyValue(options, "host");
  if (value === "absent") return host;
  return value !== "unknown" && hostName(value) === host ? host : undefined;
}

/** A function given where options could be: a callback. */
function isCallback(node: Node): boolean {
  return node.getType().getCallSignatures().length > 0;
}

/**
 * Whether an http(s) request's `agent` option could connect somewhere other than its host. An
 * agent makes the connection, so only none (`false`, `undefined`, or absent) or a written-out
 * `new http.Agent({...})` / `new https.Agent({...})` without a spread or a redirecting option
 * leaves the host as written; any other agent (a variable, a subclass) could have its own
 * `lookup` or `createConnection`.
 */
function agentRedirects(options: ObjectLiteralExpression): boolean {
  const agent = propertyValue(options, "agent");
  if (agent === "absent") return false;
  if (agent === "unknown") return true;
  const value = Node.isShorthandPropertyAssignment(agent) ? agent : unwrapExpression(agent);
  if (value.getKind() === SyntaxKind.FalseKeyword || (Node.isIdentifier(value) && value.getText() === "undefined")) return false;
  const construct = agentConstruction(value);
  if (!construct) return true;
  const [config] = construct.getArguments();
  const literal = config && unwrapExpression(config);
  return literal !== undefined && (!Node.isObjectLiteralExpression(literal) || redirects(literal, REDIRECTING_OPTIONS));
}

/**
 * The `new http.Agent(...)` or `new https.Agent(...)` an agent option is: written in place, or
 * held by a `const` the program never changes (`const agent = new https.Agent({ keepAlive: true })`;
 * see isWritten). Undefined for anything else, a subclass included.
 */
function agentConstruction(value: Node): NewExpression | undefined {
  let construct = value;
  if (Node.isIdentifier(value) || Node.isShorthandPropertyAssignment(value)) {
    // In `{ agent }`, the name is also the value.
    const declaration = (Node.isShorthandPropertyAssignment(value) ? value.getValueSymbol() : value.getSymbol())?.getDeclarations()[0];
    const name = Node.isVariableDeclaration(declaration) && isConst(declaration) ? declaration.getNameNode() : undefined;
    const initializer = declaration && Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
    if (!Node.isIdentifier(name) || !initializer || isWritten(name)) return undefined;
    construct = unwrapExpression(initializer);
  }
  return Node.isNewExpression(construct) && isNodeAgent(construct) ? construct : undefined;
}

/** `new http.Agent(...)` or `new https.Agent(...)`: Node's own agent class, not a subclass. */
function isNodeAgent(construct: NewExpression): boolean {
  const declarations = construct.getType().getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => {
    if (!Node.isClassDeclaration(d) || d.getName() !== "Agent") return false;
    const module = d.getFirstAncestor((a) => Node.isModuleDeclaration(a) && Node.isStringLiteral(a.getNameNode()));
    return Node.isModuleDeclaration(module) && /^(node:)?https?$/.test(module.getNameNode().getText().slice(1, -1));
  });
}

/** Whether an options object sets, or may set, any of `keys`. */
function redirects(options: ObjectLiteralExpression, keys: readonly string[]): boolean {
  return keys.some((key) => propertyValue(options, key) !== "absent");
}

/** The literal host an option names; undefined if it's not set, or can't be read. */
function optionHost(options: ObjectLiteralExpression, key: string): string | undefined {
  const value = propertyValue(options, key);
  return value === "absent" || value === "unknown" ? undefined : hostName(value);
}

/** A literal host name, without a port (`host: "internal.example:8080"`), in lower case. */
function hostName(value: Node): string | undefined {
  return literalString(value)?.replace(/:\d+$/, "").toLowerCase() || undefined;
}

/** The global `URL` class, not a local one with the same name. */
function isGlobalUrl(expression: Node): boolean {
  if (!Node.isIdentifier(expression) || expression.getText() !== "URL") return false;
  const declarations = expression.getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile());
}
