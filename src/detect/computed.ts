// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Calls through a computed key, `obj[key](...)`. With a single literal key they
// resolve like any other call. Otherwise:
//   - on a sensitive object (fs, globalThis, an SDK), any capability function
//     could be reached, so the call is unverifiable;
//   - on a first-party object with known members, every member the key allows
//     could be called, so each becomes a call-graph edge;
//   - behind an index signature (arrays, Record<string, Fn>), the functions
//     can't be known, so the call is unverifiable.

import { Node, SyntaxKind, VariableDeclarationKind, type ElementAccessExpression, type ObjectLiteralExpression, type Symbol as MorphSymbol, type Type } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { unwrapExpression, type CallLike } from "./shared.js";
import { functionCapabilities } from "./values.js";

export type ComputedTarget =
  | { kind: "resolved" }
  | { kind: "sensitive" }
  | { kind: "members"; members: MorphSymbol[] }
  | { kind: "unknown" };

/** The element access a call goes through, if its callee is `obj[key]`. */
export function computedCallee(call: CallLike): ElementAccessExpression | undefined {
  if (Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  return Node.isElementAccessExpression(callee) ? callee : undefined;
}

export function classifyComputedCall(access: ElementAccessExpression, adapters: AdapterIndex): ComputedTarget {
  const key = access.getArgumentExpression();
  const keyType = key?.getType();
  if (!key || !keyType) return { kind: "unknown" };
  // A cast gives the key a literal type without a literal value, so its type narrows nothing.
  const cast = key.getDescendantsOfKind(SyntaxKind.AsExpression).length > 0 || Node.isAsExpression(key) ||
    Node.isTypeAssertion(key) || key.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression).length > 0;
  if (!cast && (keyType.isStringLiteral() || keyType.isNumberLiteral())) return { kind: "resolved" };

  const object = access.getExpression();
  const objectType = object.getType();
  if (objectType.isAny() || objectType.isUnknown()) return { kind: "unknown" };

  // A key union of string literals narrows the members; any other string key allows all of them.
  const allowed = !cast && keyType.isUnion() && keyType.getUnionTypes().every((t) => t.isStringLiteral())
    ? new Set(keyType.getUnionTypes().map((t) => t.getLiteralValue() as string))
    : undefined;

  // `const x: Record<string, Fn> = { a: ..., b: ... }`: the type hides the members,
  // but the initializer lists them. (Adding members later is a known limit; an
  // empty initializer means members can only come that way, so it isn't trusted.)
  const literal = constObjectLiteral(object);
  if (literal && literal.getProperties().length > 0) {
    if (literal.getProperties().some((p) => storesCapabilityFunction(p, adapters))) return { kind: "sensitive" };
    const members = literal
      .getProperties()
      .map((p) => p.getSymbol())
      .filter((s): s is MorphSymbol => s !== undefined && (!allowed || allowed.has(s.getName())));
    return { kind: "members", members };
  }

  const callable = callableMembers(objectType, access);
  if (callable.some((m) => isSensitive(m, adapters))) return { kind: "sensitive" };

  // A numeric key into an array or tuple of functions: the elements can't be named.
  if (keyType.isNumber() || keyType.isNumberLiteral()) return { kind: "unknown" };
  const index = objectType.getStringIndexType();
  if (index && index.getCallSignatures().length > 0) return { kind: "unknown" };

  const members = callable.filter((m) => !allowed || allowed.has(m.getName()));
  return members.length > 0 ? { kind: "members", members } : { kind: "unknown" };
}

/** The object literal a `const` was initialized with, if it has no spreads (so its members are all listed). */
function constObjectLiteral(expression: Node): ObjectLiteralExpression | undefined {
  const target = unwrapExpression(expression);
  if (!Node.isIdentifier(target)) return undefined;
  const declaration = target.getSymbol()?.getDeclarations()[0];
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  if (declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
  const init = declaration.getInitializer();
  const literal = init && unwrapExpression(init);
  if (!literal || !Node.isObjectLiteralExpression(literal)) return undefined;
  return literal.getProperties().some((p) => Node.isSpreadAssignment(p)) ? undefined : literal;
}

/** `{ read: readFileSync }` or `{ fetch }`, or a const alias of one: a member that is a capability function itself. */
function storesCapabilityFunction(property: Node, adapters: AdapterIndex): boolean {
  const symbol = property.getSymbol();
  return symbol !== undefined && functionCapabilities(symbol, adapters).length > 0;
}

function callableMembers(type: Type, at: Node): MorphSymbol[] {
  return type.getProperties().filter((p) => p.getTypeAtLocation(at).getCallSignatures().length > 0);
}

function isSensitive(member: MorphSymbol, adapters: AdapterIndex): boolean {
  return functionCapabilities(member, adapters).length > 0;
}
