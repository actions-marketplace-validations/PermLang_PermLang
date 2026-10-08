// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Packages that first-party code calls into but no adapter covers. PermLang can't
// see what they touch, so it trusts them (docs/design.md#design-decisions). The real-world
// trial found network SDKs among them (kafkajs, redis, AI SDKs), so they are listed
// in every report instead of passing silently. Packages that touch nothing
// PermLang tracks are declared pure in adapters/pure.json.
//
// A folder of the project's with its own package.json is a package too (units.ts): the
// JavaScript behind its .d.ts isn't analyzed. Its package.json could claim any name, so
// only a team's adapter covers it, and neither a built-in adapter nor built-in detection
// does. The exception is a client prisma-client-js generated there, which the Prisma
// detector reads as it reads @prisma/client.

import path from "node:path";
import { Node, SyntaxKind, type NoSubstitutionTemplateLiteral, type Project, type SourceFile, type StringLiteral } from "ts-morph";
import { packageOf, type AdapterIndex } from "./adapters.js";
import { isUrlSpecifier, loadOf, loadTarget, loadsData, referenceUsesRequire } from "./detect/modules.js";
import { isPrismaClientJsFile } from "./detect/prisma.js";
import { resolveAlias, resolvedDeclaration, type CallLike } from "./detect/shared.js";
import { SQL_PACKAGES, isNodeSqlite } from "./detect/sql.js";
import type { PackageFolders } from "./units.js";
import { descendantsOfKind, forEachDescendant, lineAndColumn } from "./walk.js";

export interface UnmappedPackage {
  package: string;
  calls: number;
  /** The first call, in file order. */
  file: string;
  line: number;
}

/** Packages with built-in detection instead of an adapter, or that stand for the language itself. */
const HANDLED = new Set(["fs", "module", "@prisma/client", ".prisma", "drizzle-orm", ...SQL_PACKAGES, "node", "typescript"]);

/** A package PermLang detects directly, without an adapter (Prisma, Drizzle, SQL clients, ...). */
export function isDetectedPackage(name: string): boolean {
  return HANDLED.has(name);
}

export interface UnmappedUse extends UnmappedPackage {
  /** Where the first call is, so its diagnostic can name the function. */
  node: Node;
  files: number;
  /** For a folder of the project's with its own package.json: that folder. */
  folder?: string;
}

/** A package a call reaches: installed, or a folder of the project's (with that folder). */
export interface Called {
  name: string;
  folder?: string;
}

export function unmappedPackages(sourceFiles: readonly SourceFile[], adapters: AdapterIndex, packages: PackageFolders): UnmappedUse[] {
  const found = new Map<string, UnmappedUse & { fileSet: Set<string> }>();
  for (const { node, package: pkg } of unmappedCalls(sourceFiles, adapters, packages)) {
    const sourceFile = node.getSourceFile();
    const existing = found.get(pkg.name);
    if (existing) {
      existing.calls++;
      existing.fileSet.add(sourceFile.getFilePath());
      continue;
    }
    found.set(pkg.name, {
      package: pkg.name,
      calls: 1,
      file: sourceFile.getFilePath(),
      line: lineAndColumn(sourceFile, node.getStart()).line,
      node,
      files: 1,
      fileSet: new Set([sourceFile.getFilePath()]),
      ...(pkg.folder !== undefined ? { folder: pkg.folder } : {}),
    });
  }
  return [...found.values()]
    .map(({ fileSet, ...u }) => ({ ...u, files: fileSet.size }))
    .sort((a, b) => b.calls - a.calls || a.package.localeCompare(b.package));
}

/** Every call into a package with no adapter, in file order. (Flow rules need each one; see flows.ts.) */
export function unmappedCalls(sourceFiles: readonly SourceFile[], adapters: AdapterIndex, packages: PackageFolders): { node: CallLike; package: Called }[] {
  const out: { node: CallLike; package: Called }[] = [];
  const prisma = new Map<string, boolean>();
  // A folder that holds a client prisma-client-js generated (one of its files imports Prisma's runtime).
  const isPrismaClient = (folder: string, project: Project) => {
    let known = prisma.get(folder);
    if (known === undefined) {
      known = project.getSourceFiles().some((sf) => sf.isDeclarationFile() && packages.localPackage(sf)?.folder === folder && isPrismaClientJsFile(sf));
      prisma.set(folder, known);
    }
    return known;
  };
  for (const sourceFile of sourceFiles) {
    forEachDescendant(sourceFile, (node) => {
      if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
      const pkg = untypedPackageLoad(node, adapters) ?? calledPackage(node, packages, isPrismaClient);
      if (pkg !== undefined && !isCovered(pkg, adapters)) out.push({ node, package: pkg });
    });
  }
  return out;
}

/** Whether something covers what a package does: an adapter, or built-in detection; for a folder of the project's, a team's adapter. */
function isCovered(pkg: Called, adapters: AdapterIndex): boolean {
  if (pkg.folder !== undefined) return adapters.hasTeamPackage(pkg.name);
  return HANDLED.has(pkg.name) || adapters.hasPackage(pkg.name);
}

/** The package a call's declaration belongs to, if it's third-party code. */
function calledPackage(node: CallLike, packages: PackageFolders, isPrismaClient: (folder: string, project: Project) => boolean): Called | undefined {
  // `new Client()` of a class with no declared constructor resolves to no signature; the class names the package.
  const declaration =
    resolvedDeclaration(node) ??
    (Node.isNewExpression(node) ? newTargetDeclaration(node.getExpression()) : undefined);
  if (!declaration?.getSourceFile().isDeclarationFile() && !declaration?.getSourceFile().getFilePath().includes("/node_modules/")) return undefined;
  const installed = packageOf(declaration);
  // Node's own SQLite client is detected (detect/sql.ts); the npm package called sqlite isn't.
  if (installed !== undefined) return { name: isNodeSqlite(declaration) ? "node:sqlite" : installed };
  const local = packages.localPackage(declaration);
  // A client Prisma generated into the project is the Prisma detector's, as @prisma/client is.
  if (local === undefined || isPrismaClient(local.folder, declaration.getProject())) return undefined;
  return local;
}

/** `require("kafkajs")`, or import() through a const: the package is used through `any`, like a call into it. */
function untypedPackageLoad(node: CallLike, adapters: AdapterIndex): Called | undefined {
  const load = loadOf(node);
  if (!load?.untyped) return undefined;
  const target = loadTarget(load, adapters);
  return target.kind === "package" ? { name: target.name } : undefined;
}

function newTargetDeclaration(expression: Node): Node | undefined {
  const symbol = expression.getSymbol();
  return symbol ? resolveAlias(symbol).getDeclarations()[0] : undefined;
}

export interface UnresolvedImport {
  specifier: string;
  file: string;
  line: number;
  node: Node;
}

/**
 * Imports whose types can't be found (a missing @types package, say). Nothing
 * called from them can be resolved, so without this their calls would pass
 * silently. First import of each module, in file order: a relative specifier
 * (`./x.cjs`) names another file from each folder. Data is left out (an asset a
 * bundler handles, or JSON: see loadsData), and so are URL specifiers, which are
 * unverifiable (detect/modules.ts).
 */
export function unresolvedImports(sourceFiles: readonly SourceFile[]): UnresolvedImport[] {
  const found = new Map<string, UnresolvedImport>();
  for (const sourceFile of sourceFiles) {
    for (const { specifierNode, node } of moduleReferences(sourceFile)) {
      const specifier = specifierNode.getLiteralValue();
      if (isUrlSpecifier(specifier) || loadsData(specifier, sourceFile, referenceUsesRequire(node))) continue;
      const key = isRelative(specifier) ? path.posix.join(sourceFile.getDirectoryPath(), specifier) : specifier;
      if (HANDLED.has(bareName(specifier)) || found.has(key) || resolves(specifierNode, node)) continue;
      found.set(key, { specifier, file: sourceFile.getFilePath(), line: lineAndColumn(sourceFile, node.getStart()).line, node });
    }
    const process = found.has(NODE_PROCESS) ? undefined : unresolvedProcess(sourceFile);
    if (process) found.set(NODE_PROCESS, { specifier: NODE_PROCESS, file: sourceFile.getFilePath(), line: process.getStartLineNumber(), node: process });
  }
  return [...found.values()];
}

// The global `process` is Node's process module, and its types come from @types/node.
const NODE_PROCESS = "node:process";

/**
 * The first use of a global `process` that doesn't resolve: Node's types are missing, so
 * process.kill(), process.chdir() and the like can't be checked. (`process.env` is still read
 * by name; see detect/env.ts.) Found in the 0.3 review.
 */
function unresolvedProcess(sourceFile: SourceFile): Node | undefined {
  if (!sourceFile.getFullText().includes("process")) return undefined;
  for (const id of descendantsOfKind(sourceFile, SyntaxKind.Identifier)) {
    // Declared names, property names, and shorthand properties all have a symbol, typed or not.
    if (id.getText() !== "process" || id.getSymbol() !== undefined) continue;
    // `x.process` on an untyped `x` isn't the global, but `globalThis.process` and `global.process` are.
    const parent = id.getParent();
    if (!Node.isPropertyAccessExpression(parent) || parent.getNameNode() !== id) return id;
    if (/^(globalThis|global)$/.test(parent.getExpression().getText())) return id;
  }
  return undefined;
}

/** `./x`, `../x`: a file, relative to the one that imports it. */
export function isRelative(specifier: string): boolean {
  return /^\.\.?(?:\/|$)/.test(specifier);
}

/**
 * "@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg". Packages with built-in detection
 * aren't reported: the trial found the generated Prisma client importing untyped runtime files.
 */
function bareName(specifier: string): string {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/** Every place a file names a module: import and export declarations, `import x = require("x")`, and `import("x")`. */
export function moduleReferences(sourceFile: SourceFile): { specifierNode: StringLiteral | NoSubstitutionTemplateLiteral; node: Node }[] {
  const references: { specifierNode: StringLiteral | NoSubstitutionTemplateLiteral; node: Node }[] = [];
  for (const decl of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
    const specifierNode = decl.getModuleSpecifier();
    if (specifierNode && !decl.isTypeOnly()) references.push({ specifierNode, node: decl });
  }
  forEachDescendant(sourceFile, (node) => {
    if (Node.isImportEqualsDeclaration(node) && !node.isTypeOnly()) {
      const reference = node.getModuleReference();
      const expression = Node.isExternalModuleReference(reference) ? reference.getExpression() : undefined;
      if (expression && Node.isStringLiteral(expression)) references.push({ specifierNode: expression, node });
    } else if (Node.isCallExpression(node) && node.getExpression().getKind() === SyntaxKind.ImportKeyword) {
      // Only a literal specifier can be checked; a computed one is reported as unverifiable elsewhere.
      const [argument] = node.getArguments();
      if (argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) references.push({ specifierNode: argument, node });
    }
  });
  return references;
}

/**
 * Whether the specifier reaches real types: a file, or an ambient `declare module "x" { … }`
 * (including wildcards like "*.svg"). A shorthand `declare module "x";` with no body types
 * everything in it `any`, which hides its calls just as a missing package does.
 */
function resolves(specifierNode: Node, node: Node): boolean {
  // A file with no imports or exports has no module symbol, but still resolves.
  if ((Node.isImportDeclaration(node) || Node.isExportDeclaration(node)) && node.getModuleSpecifierSourceFile()) return true;
  const declarations = specifierNode.getSymbol()?.getDeclarations() ?? [];
  if (declarations.length === 0) return false;
  return declarations.some((d) => !Node.isModuleDeclaration(d) || d.hasBody() || d.getName().includes("*"));
}
