// Code PermLang can't see into: calls through an import whose types can't be found, and
// names with no declaration at all (`process` or `fetch` without their types). Nothing
// they do is detected, so `permlang spec` can't say an implementation stays within its
// permissions when it reaches them. Found on demand for one function and what it calls,
// since it needs TypeScript's full diagnostics for those files.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { Edge } from "./graph.js";
import { moduleReferences, unresolvedImports } from "./unmapped.js";
import { enclosingUnitNode, type Unit } from "./units.js";

/** TypeScript's "Cannot find name" diagnostics, including the ones that suggest installing types. */
const MISSING_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593]);

/**
 * Why some of what `start` runs can't be seen, one reason per import or name, each naming
 * the function on the way to it when that isn't `start` itself.
 */
export function unseenFrom(start: Unit, edgesFrom: ReadonlyMap<Unit, readonly Edge[]>, unitOf: (node: Node) => Unit | undefined): string[] {
  // Everything start can run, with the first unit on the way to each.
  const via = new Map<Unit, Unit | undefined>([[start, undefined]]);
  for (const unit of via.keys()) {
    for (const edge of edgesFrom.get(unit) ?? []) if (!via.has(edge.to)) via.set(edge.to, via.get(unit) ?? edge.to);
  }
  const reasons = new Set<string>();
  const add = (node: Node, reason: string) => {
    const unit = unitOf(enclosingUnitNode(node));
    if (!unit || !via.has(unit)) return;
    const through = via.get(unit);
    reasons.add(through ? `${reason} (through ${through.name})` : reason);
  };
  const files = new Set([...via.keys()].map((u) => u.node.getSourceFile()));
  for (const sourceFile of files) {
    for (const { node, reason } of unseenIn(sourceFile)) add(node, reason);
  }
  return [...reasons].sort();
}

function unseenIn(sourceFile: SourceFile): { node: Node; reason: string }[] {
  const out: { node: Node; reason: string }[] = [];
  // Names bound by imports whose types can't be found, and every use of them.
  const specifiers = new Set(unresolvedImports([sourceFile]).map((u) => u.specifier));
  const reasonFor = (specifier: string) => `it calls into ${specifier}, whose types can't be found`;
  const bound = new Map<unknown, string>();
  for (const { node, specifierNode } of moduleReferences(sourceFile)) {
    const specifier = specifierNode.getLiteralValue();
    if (!specifiers.has(specifier)) continue;
    if (Node.isCallExpression(node)) out.push({ node, reason: reasonFor(specifier) });
    for (const name of boundNames(node)) bound.set(name.getSymbolOrThrow().compilerSymbol, reasonFor(specifier));
  }
  if (bound.size > 0) {
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const reason = bound.get(id.getSymbol()?.compilerSymbol);
      if (reason !== undefined && !id.getFirstAncestor((a) => Node.isImportDeclaration(a) || Node.isImportEqualsDeclaration(a))) out.push({ node: id, reason });
    }
  }
  // Names TypeScript can't find at all.
  for (const d of sourceFile.getProject().getProgram().getSemanticDiagnostics(sourceFile)) {
    const start = d.getStart();
    if (!MISSING_NAME.has(d.getCode()) || start === undefined) continue;
    // These diagnostics are on the name itself.
    const node = sourceFile.getDescendantAtPos(start)!;
    out.push({ node, reason: `it uses ${node.getText()}, which has no declaration` });
  }
  return out;
}

/** The local names an import declaration binds: `x`, `{ a, b as c }`, `* as ns`, `import x = require()`. */
function boundNames(node: Node): Node[] {
  if (Node.isImportEqualsDeclaration(node)) return [node.getNameNode()];
  if (!Node.isImportDeclaration(node)) return [];
  const namespace = node.getNamespaceImport();
  return [
    ...(node.getDefaultImport() ? [node.getDefaultImport()!] : []),
    ...(namespace ? [namespace] : []),
    ...node.getNamedImports().map((n) => n.getAliasNode() ?? n.getNameNode()),
  ];
}
