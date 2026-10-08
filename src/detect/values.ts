// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Capability functions and constructors used as values: `urls.map(fetch)`,
// `promisify(exec)`, `paths.forEach(unlinkSync)`, `Reflect.construct(WebSocket, [url])`.
// The function can then be called anywhere with any arguments, so the reference
// itself is the use, with every scope dynamic. `fn.call(thisArg, ...args)`,
// `fn.apply(thisArg, [...args])`, `Reflect.apply(fn, thisArg, [...args])`, and
// `fn.bind(thisArg, ...args)` with arguments bound are calls, checked with their
// arguments.
//
// Not counted: calling it (that's a call), `typeof fetch`, `x instanceof WebSocket`,
// testing whether it exists (`if (globalThis.fetch)`, `Boolean(globalThis.fetch)`),
// imports and exports (`export default fetch`, but not `export default [fetch]`), type
// positions, and `const f = fetch` (calls through a const alias resolve to the
// original by signature, so they're checked where they happen; `const f: any = fetch`
// erases the signature, so it does count). Using the alias itself as a value
// (`f.call(...)`, `urls.map(f)`) is a use of what it holds, and so is using a name
// destructured from a module or global (`const { exec } = cp; promisify(exec)`).
//
// A value whose code can't be seen (a declared global such as `require`, or a variable
// set by a call, such as what createRequire returns) is judged by its type: the
// functions its call signatures declare.

import { Node, SyntaxKind, VariableDeclarationKind, type BindingElement, type CallExpression, type Expression, type Identifier, type PropertyAccessExpression, type SourceFile, type Symbol as MorphSymbol, type Type } from "ts-morph";
import { packageOf, type AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { admitsString, callText, containerName, isReflectApply, literalString, resolveAlias, resolvedDeclaration, signatureDeclarations, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";
import { capabilitiesOf, constructorCapabilities, type Reach } from "./web.js";
import { descendantsOfKind } from "../walk.js";

export interface ValueUse {
  node: Node;
  uses: CapabilityUse[];
}

export function valueUses(sourceFile: SourceFile, adapters: AdapterIndex): ValueUse[] {
  const out: ValueUse[] = [];
  for (const id of descendantsOfKind(sourceFile, SyntaxKind.Identifier)) {
    const site = referenceExpression(id);
    if (!site || isExempt(site)) continue;
    const type = site.getType();
    const constructs = type.getConstructSignatures().length > 0;
    if (type.getCallSignatures().length === 0 && !constructs) continue;

    // In `{ fetch }`, the name is also the value.
    const parent = id.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : id.getSymbol();
    if (!symbol) continue;
    const invoked = invocation(site);
    const use = invoked ?? { args: [], reach: valueReach(site) };
    const capabilities =
      heldCapabilities(symbol, adapters, use) ?? (constructs ? constructorCapabilities(type, adapters) : signatureCapabilities(symbol, type, adapters, use));
    if (capabilities.length === 0) continue;
    const node = invoked?.call ?? site;
    const call = invoked ? callText(invoked.call) : `${site.getText().replace(/\s+/g, " ")} as a value`;
    out.push({ node, uses: capabilities.map((capability) => ({ capability, call, verb: invoked ? "calls" : "uses" })) });
  }
  return out;
}

/** What the function a symbol names could touch, called with any arguments; see heldCapabilities. */
export function functionCapabilities(symbol: MorphSymbol, adapters: AdapterIndex): Capability[] {
  return heldCapabilities(symbol, adapters, { args: [], reach: "value" }) ?? [];
}

// How many aliases are followed before giving up. Past it, what the chain holds is unknown.
const MAX_ALIASES = 32;

/**
 * What the function a symbol names touches, following const aliases, object properties that
 * name another function (`const run = execSync`, `{ go: fetch }`, `{ fetch }`), and names
 * destructured from an object (`const { execSync: run } = cp`). Classes are left to their
 * constructors. A chain of aliases that loops holds no function (reading it throws); one too
 * long to follow is unverifiable.
 */
function heldCapabilities(symbol: MorphSymbol, adapters: AdapterIndex, use: Use, seen = new Set<MorphSymbol>()): Capability[] | undefined {
  const target = resolveAlias(symbol);
  if (seen.has(target)) return undefined;
  if (seen.size >= MAX_ALIASES) return [{ name: UNVERIFIABLE }];
  seen.add(target);
  for (const declaration of target.getDeclarations()) {
    if (Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration)) continue;
    const held = aliasedSymbol(declaration);
    const capabilities = held ? heldCapabilities(held, adapters, use, seen) : declaredCapabilities(declaration, adapters, use);
    if (capabilities && capabilities.length > 0) return capabilities;
  }
  return undefined;
}

/**
 * A member of a mapped type, such as an extended Prisma client's operations, has no
 * declaration of its own: what it is comes from its type's call signatures.
 */
function signatureCapabilities(symbol: MorphSymbol, type: Type, adapters: AdapterIndex, use: Use): Capability[] {
  return resolveAlias(symbol).getDeclarations().length > 0 ? [] : typedCapabilities(type, adapters, use);
}

/** What the functions a type can be called as touch, reached as `use` says. */
function typedCapabilities(type: Type, adapters: AdapterIndex, use: Use): Capability[] {
  for (const declaration of signatureDeclarations(type.getCallSignatures())) {
    const capabilities = capabilitiesOf(declaration, use.args, adapters, use.reach);
    if (capabilities.length > 0) return capabilities;
  }
  return [];
}

/**
 * The symbol a const alias, an object property, or a destructured name holds: `execSync` in
 * `const run = execSync`, and in `const { execSync: run } = cp`.
 */
function aliasedSymbol(declaration: Node): MorphSymbol | undefined {
  if (Node.isShorthandPropertyAssignment(declaration)) return declaration.getValueSymbol();
  if (Node.isBindingElement(declaration)) return destructuredProperty(declaration);
  const holdsValue =
    (Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const) ||
    Node.isPropertyAssignment(declaration);
  const initializer = holdsValue ? declaration.getInitializer() : undefined;
  const value = initializer && unwrapExpression(initializer);
  if (!value) return undefined;
  if (Node.isIdentifier(value)) return value.getSymbol();
  return Node.isPropertyAccessExpression(value) ? value.getNameNode().getSymbol() : undefined;
}

/**
 * The member of the destructured object a name is bound to, at any depth: `writeFile` of
 * `fs.promises` in `const { promises: { writeFile: w } } = fs`, or in a parameter
 * `({ execSync: run }: typeof cp)`. Undefined for a computed key that can't be read. (A rest
 * element is an object, not a function; an array's element is judged by its type, in isOpaque.)
 */
function destructuredProperty(element: BindingElement): MorphSymbol | undefined {
  const pattern = element.getParent();
  if (!Node.isObjectBindingPattern(pattern)) return undefined;
  const key = element.getPropertyNameNode() ?? element.getNameNode();
  const name = Node.isComputedPropertyName(key) ? literalString(key.getExpression())
    : Node.isStringLiteral(key) ? key.getLiteralValue()
    : key.getText();
  // The pattern's type is the type of what's destructured: the initializer's, or the parameter's.
  return name === undefined ? undefined : pattern.getType().getProperty(name);
}

/**
 * A declaration whose value comes from code that isn't in sight, so its type is the best
 * account of what it holds: a declared global (`require`), a variable set by a call
 * (`const load = createRequire(...)`) or later (`let run`, assigned by destructuring), or an
 * element destructured from an array (`const [run] = runners`).
 * Not a function the project writes (`const f = () => ...`), whose body is followed instead,
 * and not a parameter, whose value is checked where it's passed.
 */
function isOpaque(declaration: Node): boolean {
  if (declaration.getSourceFile().isDeclarationFile()) {
    return Node.isVariableDeclaration(declaration) || Node.isPropertySignature(declaration);
  }
  if (Node.isBindingElement(declaration)) return Node.isArrayBindingPattern(declaration.getParent());
  if (!Node.isVariableDeclaration(declaration)) return false;
  const initializer = declaration.getInitializer();
  const value = initializer && unwrapExpression(initializer);
  return !value || !(Node.isArrowFunction(value) || Node.isFunctionExpression(value) || Node.isClassExpression(value));
}

/** What reaching a declaration touches; for an opaque one, what the functions its type can be called as touch. */
function declaredCapabilities(declaration: Node, adapters: AdapterIndex, use: Use): Capability[] {
  const capabilities = capabilitiesOf(declaration, use.args, adapters, use.reach);
  if (capabilities.length > 0 || !isOpaque(declaration)) return capabilities;
  // `require` is declared as a variable of type NodeJS.Require, whose call signature loads modules.
  return typedCapabilities(declaration.getType(), adapters, use);
}

/** How a function is reached: the arguments it's called with, when they're known. */
interface Use {
  args: Node[];
  reach: Reach;
}

interface Invocation extends Use {
  call: CallLike;
}

/**
 * How a function used as a value will be called: with anything, or, where whatever receives
 * it only ever passes it a function first (`[handler].forEach(setTimeout)`, or Node's
 * `promisify(setTimeout)`, which uses its own promise version), with functions.
 */
function valueReach(site: Expression): Reach {
  const parent = site.getParent();
  if (Node.isCallExpression(parent) && parent.getArguments()[0] === site && isNodePromisify(parent)) return "value given functions";
  // `fn.bind(thisArg)` makes a copy with the same signature, so calls through it are checked where
  // they're made, and so is a `const` holding it, used as a value. Used in place
  // (`codes.forEach(setTimeout.bind(window))`), the copy is reached as the original would be.
  const bound = boundCopy(site);
  if (bound) return isConstInitializer(bound) ? "value given functions" : valueReach(bound);
  const contextual = site.getContextualType()?.getNonNullableType();
  const signatures = contextual?.getCallSignatures() ?? [];
  const givenFunctions = signatures.length > 0 && signatures.every((signature) => {
    const [first] = signature.getParameters();
    const declaration = first?.getValueDeclaration();
    if (!first || !declaration) return first === undefined;
    const type = first.getTypeAtLocation(site);
    // A rest parameter (`...args: unknown[]`) passes its elements.
    const passed = Node.isParameterDeclaration(declaration) && declaration.isRestParameter() ? type.getArrayElementType() : type;
    return passed !== undefined && !admitsString(passed, site);
  });
  return givenFunctions ? "value given functions" : "value";
}

/** `fn.bind(thisArg)`, with no arguments bound, for `fn`. (Bound arguments make it an invocation.) */
function boundCopy(site: Node): CallExpression | undefined {
  const access = site.getParent();
  if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== site || access.getName() !== "bind") return undefined;
  const call = access.getParent();
  return Node.isCallExpression(call) && call.getExpression() === access && call.getArguments().length <= 1 ? call : undefined;
}

function isConstInitializer(node: Node): boolean {
  const parent = node.getParent();
  return Node.isVariableDeclaration(parent) && parent.getInitializer() === node && parent.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const;
}

/** Node's util.promisify. */
function isNodePromisify(call: CallExpression): boolean {
  const declaration = resolvedDeclaration(call);
  return Node.isFunctionDeclaration(declaration) && declaration.getName() === "promisify" && packageOf(declaration) === "util";
}

/**
 * `fn.call(thisArg, ...args)`, `fn.apply(thisArg, [...args])`, `fn.bind(thisArg, ...args)`, or
 * `Reflect.apply(fn, thisArg, [...args])`: a call of `fn` with known arguments.
 */
function invocation(site: Node): Invocation | undefined {
  const access = site.getParent();
  if (Node.isCallExpression(access) && access.getArguments()[0] === site && isReflectApply(access)) {
    return listed(access, access.getArguments()[2]);
  }
  if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== site) return undefined;
  const call = access.getParent();
  if (!Node.isCallExpression(call) || call.getExpression() !== access) return undefined;
  const [, ...rest] = call.getArguments();
  // `fn.bind(thisArg, a)` fixes the first arguments of every later call: a call with those.
  if (access.getName() === "call" || (access.getName() === "bind" && rest.length > 0)) return { call, args: rest, reach: "called" };
  return access.getName() === "apply" ? listed(call, rest[0]) : undefined;
}

/** A call whose arguments are given as a list: known when it's an array literal with no spread. */
function listed(call: CallExpression, list: Node | undefined): Invocation {
  const array = list && unwrapExpression(list);
  const known = array && Node.isArrayLiteralExpression(array) && !array.getElements().some((e) => Node.isSpreadElement(e));
  return known ? { call, args: array.getElements(), reach: "called" } : { call, args: [], reach: "called with unknown arguments" };
}

/** The expression an identifier is a value reference through (`fetch`, or `axios.get` for its `get`), if any. */
function referenceExpression(id: Identifier): Identifier | PropertyAccessExpression | undefined {
  const parent = id.getParent();
  if (!parent) return undefined;
  if (Node.isPropertyAccessExpression(parent)) {
    // `a.b`: the reference is through `b` (the whole access); `a` alone is just an object,
    // except in `fetch.call(...)`, `fetch.apply(...)`, `fetch.bind(...)`, which invoke `a`.
    if (parent.getNameNode() === id) return parent;
    return /^(call|apply|bind)$/.test(parent.getName()) ? id : undefined;
  }
  if (Node.isShorthandPropertyAssignment(parent)) return id;
  // Declaration names, parameter names, property names, labels.
  if ("getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === id) return undefined;
  return id;
}

function isExempt(site: Node): boolean {
  const parent = site.getParent();
  if (!parent) return true;
  // Called: the call detector handles it, with its arguments.
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === site) return true;
  if (Node.isTaggedTemplateExpression(parent) && parent.getTag() === site) return true;
  // `fetch.call(...)` and `fetch.bind(...)` are uses: `fetch` is the object of an access, handled here.
  // `a.b.c`: only the outermost access that is a value counts, not `a.b` as an object.
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === site) {
    return !/^(call|apply|bind)$/.test(parent.getName());
  }
  if (Node.isTypeOfExpression(parent) || isExistenceTest(site)) return true;
  // A const alias: calls through it resolve by signature. Not when an annotation erases the
  // signature (`const f: any = fetch`): nothing called through it can be resolved, so the
  // reference itself is the use.
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === site && Node.isIdentifier(parent.getNameNode())) {
    const type = parent.getType();
    const keepsSignature = type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
    return parent.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const && keepsSignature;
  }
  // `export default fetch` and `export = run` export the function itself, like `export { run }`:
  // calls through the import resolve to it. Inside a larger expression (`export default [run]`,
  // `export default { pick: () => run }`), it's a value like any other.
  let whole = site;
  while (Node.isParenthesizedExpression(whole.getParent())) whole = whole.getParentOrThrow();
  if (Node.isExportAssignment(whole.getParent())) return true;
  for (const a of site.getAncestors()) {
    if (Node.isTypeNode(a) || Node.isImportDeclaration(a) || Node.isExportDeclaration(a)) return true;
    if (Node.isStatement(a)) break;
  }
  return false;
}

const COMPARISONS = new Set([
  SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken,
]);

/**
 * Feature detection, which never calls the function: `if (globalThis.fetch)`, `!WebSocket`,
 * `Boolean(globalThis.fetch)`, `fetch === undefined`, `x instanceof WebSocket`, the condition
 * of `?:`, the left of `&&`, and either side of `&&` or `||` when the whole is a test itself
 * (`if (typeof window !== "undefined" && window.WebSocket)`).
 */
function isExistenceTest(site: Node): boolean {
  const parent = site.getParentOrThrow();
  // An if's only expression is its condition.
  if (Node.isIfStatement(parent)) return true;
  if (Node.isParenthesizedExpression(parent)) return isExistenceTest(parent);
  if (Node.isPrefixUnaryExpression(parent)) return parent.getOperatorToken() === SyntaxKind.ExclamationToken;
  if (Node.isConditionalExpression(parent)) return parent.getCondition() === site;
  if (Node.isCallExpression(parent)) return parent.getArguments().length === 1 && isGlobalBoolean(parent);
  if (!Node.isBinaryExpression(parent)) return false;
  const operator = parent.getOperatorToken().getKind();
  if (operator === SyntaxKind.AmpersandAmpersandToken) return parent.getLeft() === site || isExistenceTest(parent);
  if (operator === SyntaxKind.BarBarToken) return isExistenceTest(parent);
  if (operator === SyntaxKind.InstanceOfKeyword) return parent.getRight() === site;
  return COMPARISONS.has(operator);
}

/** `Boolean(x)`, the global function, which converts its argument without calling it. */
function isGlobalBoolean(call: CallExpression): boolean {
  const declaration = resolvedDeclaration(call);
  return Node.isCallSignatureDeclaration(declaration) && containerName(declaration) === "BooleanConstructor" && declaration.getSourceFile().isDeclarationFile();
}
