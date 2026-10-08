// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// The global fetch. A local function named `fetch` is not the network.

import { Node, type CallExpression } from "ts-morph";
import type { Capability } from "../capability.js";
import { hostOf, isGlobalLibFunction, propertyValue, unwrapExpression } from "./shared.js";

/** The capability of calling fetch with `args`; no args means fetch used as a value. */
export function fetchCapability(args: readonly Node[]): Capability {
  const host = redirects(args[1]) ? undefined : hostOf(args[0]);
  return host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host };
}

/**
 * Whether a fetch's options could send the request somewhere other than its URL's host. Node's
 * fetch takes a `dispatcher` (an undici Agent with its own DNS lookup or connection, say), so
 * options that set one, may set one (a spread, a computed key), or aren't written out where
 * they're used (a variable) do. Browsers ignore it, but the same code can run on Node.
 */
function redirects(written: Node | undefined): boolean {
  const init = written && unwrapExpression(written);
  if (!init || (Node.isIdentifier(init) && init.getText() === "undefined")) return false;
  return !Node.isObjectLiteralExpression(init) || propertyValue(init, "dispatcher") !== "absent";
}

/** The global fetch from lib.dom or @types/node, however it was reached. */
export function isGlobalFetch(declaration: Node): boolean {
  if (isGlobalLibFunction(declaration, "fetch")) return true;
  // `window.fetch` and `self.fetch` resolve to the method lib.dom and lib.webworker declare on
  // WindowOrWorkerGlobalScope, not to the global function.
  if (!Node.isMethodSignature(declaration) || declaration.getName() !== "fetch") return false;
  if (!declaration.getSourceFile().isDeclarationFile()) return false;
  const owner = declaration.getParent();
  return Node.isInterfaceDeclaration(owner) && owner.getName() === "WindowOrWorkerGlobalScope";
}

/**
 * Without type information (no lib or @types/node), assume a bare `fetch` or
 * `globalThis.fetch` that doesn't resolve is the global rather than silently passing.
 */
export function isUnresolvedFetch(call: CallExpression): boolean {
  const callee = call.getExpression();
  const nameNode = Node.isIdentifier(callee)
    ? callee
    : Node.isPropertyAccessExpression(callee) && /^(globalThis|window|self|global)$/.test(callee.getExpression().getText())
      ? callee.getNameNode()
      : undefined;
  return nameNode?.getText() === "fetch" && nameNode.getSymbol() === undefined;
}
