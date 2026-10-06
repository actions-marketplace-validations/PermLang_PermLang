// Packages that first-party code calls into but no adapter covers. PermLang can't
// see what they touch, so it trusts them (design doc decision D1). The real-world
// trial found network SDKs among them (kafkajs, redis, AI SDKs), so they are listed
// in every report instead of passing silently. Packages that touch nothing
// PermLang tracks are declared pure in adapters/pure.json.

import { Node, SyntaxKind, type NoSubstitutionTemplateLiteral, type SourceFile, type StringLiteral } from "ts-morph";
import { packageOf, type AdapterIndex } from "./adapters.js";
import { resolveAlias, resolvedDeclaration } from "./detect/shared.js";
import { SQL_PACKAGES } from "./detect/sql.js";

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
}

export function unmappedPackages(sourceFiles: readonly SourceFile[], adapters: AdapterIndex): UnmappedUse[] {
  const found = new Map<string, UnmappedUse & { fileSet: Set<string> }>();
  for (const sourceFile of sourceFiles) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
      // `new Client()` of a class with no declared constructor resolves to no signature; the class names the package.
      const declaration =
        resolvedDeclaration(node) ??
        (Node.isNewExpression(node) ? newTargetDeclaration(node.getExpression()) : undefined);
      if (!declaration?.getSourceFile().isDeclarationFile() && !declaration?.getSourceFile().getFilePath().includes("/node_modules/")) return;
      const pkg = packageOf(declaration);
      if (pkg === undefined || HANDLED.has(pkg) || adapters.hasPackage(pkg)) return;

      const existing = found.get(pkg);
      if (existing) {
        existing.calls++;
        existing.fileSet.add(sourceFile.getFilePath());
        return;
      }
      found.set(pkg, {
        package: pkg,
        calls: 1,
        file: sourceFile.getFilePath(),
        line: node.getStartLineNumber(),
        node,
        files: 1,
        fileSet: new Set([sourceFile.getFilePath()]),
      });
    });
  }
  return [...found.values()]
    .map(({ fileSet, ...u }) => ({ ...u, files: fileSet.size }))
    .sort((a, b) => b.calls - a.calls || a.package.localeCompare(b.package));
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

// Non-code imports that bundlers handle; TypeScript doesn't resolve them without declarations.
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|txt|wasm|html)(\?.*)?$/i;

/**
 * Imports whose types can't be found (a missing @types package, say). Nothing
 * called from them can be resolved, so without this their calls would pass
 * silently. First import of each specifier, in file order.
 */
export function unresolvedImports(sourceFiles: readonly SourceFile[]): UnresolvedImport[] {
  const found = new Map<string, UnresolvedImport>();
  for (const sourceFile of sourceFiles) {
    for (const { specifierNode, node } of moduleReferences(sourceFile)) {
      const specifier = specifierNode.getLiteralValue();
      if (ASSET.test(specifier) || HANDLED.has(bareName(specifier)) || found.has(specifier) || resolves(specifierNode, node)) continue;
      found.set(specifier, { specifier, file: sourceFile.getFilePath(), line: node.getStartLineNumber(), node });
    }
  }
  return [...found.values()];
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
  sourceFile.forEachDescendant((node) => {
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
