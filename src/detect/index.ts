// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Finds every place in a file that directly uses a capability.
//
// Detection is by resolved declaration, not by name: a local function called
// `fetch` is not the network, and `const post = axios.post; post(url)` is still
// axios. Code whose effects can't be determined is reported as unverifiable.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { classifyComputedCall, computedCallee } from "./computed.js";
import { envUses } from "./env.js";
import { anyEscapes } from "./escapes.js";
import { fetchCapability, isUnresolvedFetch } from "./fetch.js";
import { schemaSqlReads } from "./drizzle.js";
import { computedModels } from "./prisma.js";
import { declarationCapabilities, isTimer } from "./functions.js";
import { isUrlSpecifier, loadOf, loadTarget } from "./modules.js";
import { argumentsOf, callText, literalString, resolveAlias, resolvedDeclaration, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";
import { descendantsOfKind, forEachDescendant } from "../walk.js";
import { valueUses } from "./values.js";
import { webCapabilities } from "./web.js";

export type { CapabilityUse } from "./shared.js";

export interface DetectedUse {
  /** Where the use is; its enclosing unit is charged with it. */
  node: Node;
  uses: CapabilityUse[];
}

export function detectInFile(sourceFile: SourceFile, adapters: AdapterIndex): DetectedUse[] {
  const found: DetectedUse[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const capabilities = callCapabilities(node, adapters);
    if (capabilities.length === 0) return;
    const call = callText(node);
    found.push({ node, uses: capabilities.map((capability) => ({ capability, call, verb: "calls" })) });
  });
  found.push(...urlImports(sourceFile), ...envUses(sourceFile), ...valueUses(sourceFile, adapters), ...anyEscapes(sourceFile, adapters), ...schemaSqlReads(sourceFile), ...computedModels(sourceFile));
  return found;
}

const unverifiable: Capability[] = [{ name: UNVERIFIABLE }];

/** `import "data:..."`, `export * from "https://..."`: code that isn't in the project runs on import. */
function urlImports(sourceFile: SourceFile): DetectedUse[] {
  const declarations = [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations(), ...descendantsOfKind(sourceFile, SyntaxKind.ImportEqualsDeclaration)];
  return declarations.flatMap((node) => {
    const specifier = moduleSpecifierOf(node);
    if (specifier === undefined || !isUrlSpecifier(specifier)) return [];
    const call = node.getText().replace(/\s+/g, " ");
    return [{ node, uses: [{ capability: unverifiable[0]!, call: call.length > 70 ? `${call.slice(0, 67)}...` : call, verb: "calls" as const }] }];
  });
}

function moduleSpecifierOf(node: Node): string | undefined {
  if (Node.isImportDeclaration(node) || Node.isExportDeclaration(node)) return node.isTypeOnly() ? undefined : node.getModuleSpecifierValue();
  if (!Node.isImportEqualsDeclaration(node) || node.isTypeOnly()) return undefined;
  const reference = node.getModuleReference();
  return Node.isExternalModuleReference(reference) ? literalString(reference.getExpression()) : undefined;
}

function callCapabilities(call: CallLike, adapters: AdapterIndex): Capability[] {
  // require(x) and import(x). A typed load is followed like an import (call-graph edges);
  // an untyped one by what it loads (modules.ts). A URL is never typed.
  const load = loadOf(call);
  if (load) {
    if (!load.untyped && !(load.specifier !== undefined && isUrlSpecifier(load.specifier))) return [];
    return loadTarget(load, adapters).kind === "unverifiable" ? unverifiable : [];
  }

  const computed = computedCallee(call);
  if (computed) {
    const target = classifyComputedCall(computed, adapters);
    if (target.kind === "sensitive" || target.kind === "unknown") return unverifiable;
    // "members" become call-graph edges; "resolved" falls through to a normal call.
  }

  // A value typed `Function` could be the Function constructor itself:
  // `(() => {}).constructor("code")()` is eval without naming either.
  if (!Node.isTaggedTemplateExpression(call) && isFunctionTyped(call.getExpression())) return unverifiable;

  // Types erased with `any`: `(setTimeout as any)("code")`.
  const erased = erasedCallee(call);
  if (erased && isTimer(erased) && evaluatesString(argumentsOf(call)[0])) return unverifiable;

  const declaration = resolvedDeclaration(call);
  const web = webCapabilities(call, declaration);
  if (web.length > 0) return web;
  if (declaration) {
    if (isTimer(declaration) && evaluatesString(argumentsOf(call)[0])) return unverifiable;
    return declarationCapabilities(declaration, argumentsOf(call), adapters, call);
  }
  if (Node.isCallExpression(call) && isUnresolvedFetch(call)) return [fetchCapability(call.getArguments())];
  return [];
}

/** The declaration under a callee cast to `any`: `(setTimeout as any)`. */
function erasedCallee(call: CallLike): Node | undefined {
  if (Node.isTaggedTemplateExpression(call)) return undefined;
  const written = call.getExpression();
  const callee = unwrapExpression(written);
  if (callee === written || !Node.isIdentifier(callee)) return undefined;
  const symbol = callee.getSymbol();
  return symbol ? resolveAlias(symbol).getDeclarations()[0] : undefined;
}

/** An expression of the global `Function` interface type, which has no call signatures to resolve. */
function isFunctionTyped(expression: Node): boolean {
  const type = unwrapExpression(expression).getType();
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false;
  const symbol = type.getSymbol();
  return symbol?.getName() === "Function" && symbol.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile());
}

/** setTimeout("code") evaluates its string, even when a cast hides it from the type checker. */
function evaluatesString(arg: Node | undefined): boolean {
  if (!arg) return false;
  const inner = unwrapExpression(arg);
  return (
    Node.isStringLiteral(inner) ||
    Node.isNoSubstitutionTemplateLiteral(inner) ||
    Node.isTemplateExpression(inner) ||
    inner.getType().isString() ||
    inner.getType().isStringLiteral() ||
    inner.getType().isTemplateLiteral()
  );
}
