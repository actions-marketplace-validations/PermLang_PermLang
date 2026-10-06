// Capability functions and constructors used as values: `urls.map(fetch)`,
// `promisify(exec)`, `paths.forEach(unlinkSync)`, `Reflect.construct(WebSocket, [url])`.
// The function can then be called anywhere with any arguments, so the reference
// itself is the use, with every scope dynamic. `fn.call(thisArg, ...args)` and
// `fn.apply(thisArg, [...args])` are calls, checked with their arguments.
//
// Not counted: calling it (that's a call), `typeof fetch`, `x instanceof WebSocket`,
// testing whether it exists (`if (globalThis.fetch)`), imports and exports, type
// positions, and `const f = fetch` (calls through a const alias resolve to the
// original by signature, so they're checked where they happen; `const f: any = fetch`
// erases the signature, so it does count). Using the alias itself as a value
// (`f.call(...)`, `urls.map(f)`) is a use of what it holds.

import { Node, SyntaxKind, type Identifier, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import type { Capability } from "../capability.js";
import { callText, resolveAlias, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";
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
    const capabilities = heldCapabilities(symbol, adapters, invoked) ?? (constructs ? constructorCapabilities(type, adapters) : []);
    if (capabilities.length === 0) continue;
    const node = invoked?.call ?? site;
    const call = invoked ? callText(invoked.call) : `${site.getText().replace(/\s+/g, " ")} as a value`;
    out.push({ node, uses: capabilities.map((capability) => ({ capability, call, verb: invoked ? "calls" : "uses" })) });
  }
  return out;
}

/** What the function a symbol names could touch, called with any arguments; see heldCapabilities. */
export function functionCapabilities(symbol: MorphSymbol, adapters: AdapterIndex): Capability[] {
  return heldCapabilities(symbol, adapters, undefined) ?? [];
}

/**
 * What the function a symbol names touches, following const aliases and object properties
 * that name another function (`const run = execSync`, `{ go: fetch }`, `{ fetch }`).
 * Classes are left to their constructors.
 */
function heldCapabilities(symbol: MorphSymbol, adapters: AdapterIndex, invoked: Invocation | undefined, depth = 0): Capability[] | undefined {
  if (depth > 8) return undefined;
  for (const declaration of resolveAlias(symbol).getDeclarations()) {
    if (Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration)) continue;
    const held = aliasedSymbol(declaration);
    const capabilities = held
      ? heldCapabilities(held, adapters, invoked, depth + 1)
      : capabilitiesOf(declaration, invoked?.args ?? [], adapters, invoked?.reach ?? "value");
    if (capabilities && capabilities.length > 0) return capabilities;
  }
  return undefined;
}

/** The symbol a const alias or an object property holds: `execSync` in `const run = execSync`. */
function aliasedSymbol(declaration: Node): MorphSymbol | undefined {
  if (Node.isShorthandPropertyAssignment(declaration)) return declaration.getValueSymbol();
  const holdsValue =
    (Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === "const") ||
    Node.isPropertyAssignment(declaration);
  const initializer = holdsValue ? declaration.getInitializer() : undefined;
  const value = initializer && unwrapExpression(initializer);
  if (!value) return undefined;
  if (Node.isIdentifier(value)) return value.getSymbol();
  return Node.isPropertyAccessExpression(value) ? value.getNameNode().getSymbol() : undefined;
}

interface Invocation {
  call: CallLike;
  args: Node[];
  reach: Reach;
}

/** `fn.call(thisArg, ...args)` or `fn.apply(thisArg, [...args])`: a call of `fn` with known arguments. */
function invocation(site: Node): Invocation | undefined {
  const access = site.getParent();
  if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== site) return undefined;
  const call = access.getParent();
  if (!Node.isCallExpression(call) || call.getExpression() !== access) return undefined;
  const [, ...rest] = call.getArguments();
  if (access.getName() === "call") return { call, args: rest, reach: "called" };
  if (access.getName() !== "apply") return undefined;
  const list = rest[0] && unwrapExpression(rest[0]);
  const known = list && Node.isArrayLiteralExpression(list) && !list.getElements().some((e) => Node.isSpreadElement(e));
  return known ? { call, args: list.getElements(), reach: "called" } : { call, args: [], reach: "called with unknown arguments" };
}

/** The expression an identifier is a value reference through (`fetch`, or `axios.get` for its `get`), if any. */
function referenceExpression(id: Identifier): Node | undefined {
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
    return parent.getVariableStatement()?.getDeclarationKind() === "const" && keepsSignature;
  }
  for (const a of site.getAncestors()) {
    if (Node.isTypeNode(a) || Node.isImportDeclaration(a) || Node.isExportDeclaration(a) || Node.isExportAssignment(a)) {
      return true;
    }
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
 * `fetch === undefined`, `x instanceof WebSocket`, the condition of `?:`, the left of `&&`,
 * and either side of `&&` or `||` when the whole is a test itself
 * (`if (typeof window !== "undefined" && window.WebSocket)`).
 */
function isExistenceTest(site: Node): boolean {
  const parent = site.getParentOrThrow();
  // An if's only expression is its condition.
  if (Node.isIfStatement(parent)) return true;
  if (Node.isParenthesizedExpression(parent)) return isExistenceTest(parent);
  if (Node.isPrefixUnaryExpression(parent)) return parent.getOperatorToken() === SyntaxKind.ExclamationToken;
  if (Node.isConditionalExpression(parent)) return parent.getCondition() === site;
  if (!Node.isBinaryExpression(parent)) return false;
  const operator = parent.getOperatorToken().getKind();
  if (operator === SyntaxKind.AmpersandAmpersandToken) return parent.getLeft() === site || isExistenceTest(parent);
  if (operator === SyntaxKind.BarBarToken) return isExistenceTest(parent);
  if (operator === SyntaxKind.InstanceOfKeyword) return parent.getRight() === site;
  return COMPARISONS.has(operator);
}
