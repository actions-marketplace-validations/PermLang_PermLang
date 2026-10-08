// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// What calling a declaration touches. Shared by direct calls (with their
// arguments), functions used as values (no arguments, so every scope is
// dynamic), and computed calls (to decide whether an object is sensitive).

import { Node, type Type } from "ts-morph";
import { packageName, packageOf, type AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { fetchCapability, isGlobalFetch } from "./fetch.js";
import { fsCapabilities, fsFunctionName } from "./fs.js";
import { drizzleCapabilities } from "./drizzle.js";
import { isPrismaClient, prismaCapabilities } from "./prisma.js";
import { containerName, isGlobalLibFunction, type CallLike } from "./shared.js";
import { SQL_PACKAGES, isNodeSqlite, sqlCapabilities } from "./sql.js";

export function declarationCapabilities(
  declaration: Node,
  args: readonly Node[],
  adapters: AdapterIndex,
  call?: CallLike,
): Capability[] {
  if (isGlobalFetch(declaration)) return [fetchCapability(args)];
  if (runsArbitraryCode(declaration)) return [{ name: UNVERIFIABLE }];
  const fs = fsFunctionName(declaration);
  if (fs !== undefined) return fsCapabilities(fs, args);
  // Database clients are recognized by their own packages; adapters still apply on top.
  const db = [prismaCapabilities, sqlCapabilities, drizzleCapabilities].flatMap((database) => database(declaration, call));
  return [...db, ...adapters.forDeclaration(declaration, args)];
}

/**
 * Built-ins that run code the checker can't see: `eval`, the `Function`
 * constructor, and `require` (its result is `any`, so nothing called on it can be
 * checked; use `import` instead). A call to require() with a harmless literal
 * specifier is let through by `requiresCapabilityModule`.
 */
export function runsArbitraryCode(declaration: Node): boolean {
  if (isGlobalLibFunction(declaration, "eval") || isGlobalLibFunction(declaration, "Function")) return true;
  if (!declaration.getSourceFile().isDeclarationFile()) return false;
  const isSignature = Node.isCallSignatureDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration);
  if (!isSignature) return false;
  const container = containerName(declaration);
  return container === "FunctionConstructor" || container === "Require";
}

export function isRequire(declaration: Node): boolean {
  return declaration.getSourceFile().isDeclarationFile() && Node.isCallSignatureDeclaration(declaration) && containerName(declaration) === "Require";
}

// Node built-ins whose functions carry capabilities, or run code the checker can't see.
const CAPABILITY_BUILTINS = new Set([
  "child_process", "fs", "fs/promises", "http", "https", "http2", "net", "tls", "dgram", "dns",
  "vm", "worker_threads", "cluster", "inspector", "module", "process",
]);

// Database clients detected directly rather than by an adapter (prisma.ts, drizzle.ts, sql.ts).
const DATABASE_PACKAGES = new Set(["@prisma/client", ".prisma", "drizzle-orm", ...SQL_PACKAGES]);

/**
 * A value of a database client's own type: a Prisma client or one of its models, a Drizzle
 * database, a SQL client's pool or connection. Cast to `any`, its members are still looked
 * up on that type (escapes.ts).
 */
export function isDatabaseObject(type: Type): boolean {
  for (const part of [type, ...(type.isIntersection() ? type.getIntersectionTypes() : [])]) {
    for (const symbol of [part.getSymbol(), part.getAliasSymbol()]) {
      for (const d of symbol?.getDeclarations() ?? []) {
        if (!Node.isClassDeclaration(d) && !Node.isInterfaceDeclaration(d) && !Node.isTypeAliasDeclaration(d)) continue;
        const pkg = packageOf(d);
        if ((pkg !== undefined && DATABASE_PACKAGES.has(packageName(pkg))) || isNodeSqlite(d) || isPrismaClient(d)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether a module's untyped value (from require(), or a namespace cast to `any`) could
 * reach a capability: a Node built-in that has them, a database client, or a package an
 * adapter maps. Callers rule out packages declared pure first; other packages and
 * project files are handled by modules.ts.
 */
export function requiresCapabilityModule(specifier: string | undefined, adapters: AdapterIndex): boolean {
  if (specifier === undefined) return true;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  const bare = specifier.replace(/^node:/, "");
  const pkg = packageName(bare);
  return CAPABILITY_BUILTINS.has(bare) || CAPABILITY_BUILTINS.has(bare.split("/")[0]!) || DATABASE_PACKAGES.has(pkg) || adapters.hasPackage(bare);
}

const TIMERS = ["setTimeout", "setInterval", "setImmediate"];

/** setTimeout and friends, which evaluate a string first argument as code. */
export function isTimer(declaration: Node): boolean {
  return TIMERS.some((name) => isGlobalLibFunction(declaration, name));
}
