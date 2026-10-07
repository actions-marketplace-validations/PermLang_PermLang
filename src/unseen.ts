// Code PermLang can't see into: calls through an import whose types can't be found, names
// with no declaration at all (`process` or `fetch` without their types), and calls through a
// value typed `any`. Nothing they do is detected, so `permlang spec` can't say an
// implementation stays within its permissions when it reaches them. Found on demand for one
// function and what it calls, since it needs TypeScript's full diagnostics for those files.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { Edge } from "./graph.js";
import { moduleReferences, unresolvedImports } from "./unmapped.js";
import { enclosingUnitNode, type Unit } from "./units.js";
import { forEachDescendant } from "./walk.js";

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
  // An anonymous function reached through its type (units.ts) runs part of the unit around it.
  const anonymous = [...via.keys()].filter((u) => u.around !== undefined);
  const add = (node: Node, reason: string) => {
    const around = unitOf(enclosingUnitNode(node));
    const unit = around && via.has(around) ? around : anonymous.find((u) => u.around === around && u.node.getPos() <= node.getPos() && node.getEnd() <= u.node.getEnd());
    if (!unit) return;
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
  const untyped = untypedImportUses(sourceFile);
  const out: { node: Node; reason: string }[] = untyped.map(({ node, specifier }) => ({
    node,
    reason: `it calls into ${specifier}, whose types can't be found`,
  }));
  // Calls through a value typed `any` (`run(...)` with `run: any`, `JSON.parse(s).send()`): what
  // runs can't be known. Names explained already (an import with no types, a name with no
  // declaration) aren't repeated.
  const explained = new Set<Node>(untyped.map((u) => u.node));
  forEachDescendant(sourceFile, (node) => {
    const callee = Node.isCallExpression(node) || Node.isNewExpression(node) ? node.getExpression() : Node.isTaggedTemplateExpression(node) ? node.getTag() : undefined;
    if (!callee || !callee.getType().isAny()) return;
    const root = rootOf(callee);
    // A module loaded with import() or require() is followed as a module (graph.ts), or reported as one with no types.
    if (Node.isCallExpression(root) || root.getKind() === SyntaxKind.ImportKeyword) return;
    if (Node.isIdentifier(root) && (explained.has(root) || root.getSymbol() === undefined)) return;
    out.push({ node, reason: `it calls ${shortText(callee)}, ${TYPED_ANY}` });
  });
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

/** How a reason about a call through `any` ends, so `permlang spec` can say how to fix it. */
export const TYPED_ANY = "whose type is any";

/**
 * What an expression starts from: the name `lib` in `lib.exec`, `JSON` in `JSON.parse(s).send`,
 * or the loading call in `require("x").run` and `(await import("x")).run`.
 */
function rootOf(expression: Node): Node {
  let node = expression;
  for (;;) {
    if (Node.isCallExpression(node) && (node.getExpression().getKind() === SyntaxKind.ImportKeyword || node.getExpression().getText() === "require")) return node;
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node) || Node.isCallExpression(node) || Node.isNewExpression(node)) node = node.getExpression();
    else if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node) || Node.isAsExpression(node) || Node.isAwaitExpression(node)) node = node.getExpression();
    else return node;
  }
}

/** The first 60 characters of an expression, on one line, without parentheses around it. */
function shortText(node: Node): string {
  const inner = Node.isParenthesizedExpression(node) ? node.getExpression() : node;
  const text = inner.getText().replace(/\s+/g, " ");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Uses of imports whose types can't be found: a dynamic `import("x")`, and every use of a name
 * an import binds. (Flow rules count them too; see flows.ts.)
 */
export function untypedImportUses(sourceFile: SourceFile): { node: Node; specifier: string }[] {
  const out: { node: Node; specifier: string }[] = [];
  const specifiers = new Set(unresolvedImports([sourceFile]).map((u) => u.specifier));
  const bound = new Map<unknown, string>();
  for (const { node, specifierNode } of moduleReferences(sourceFile)) {
    const specifier = specifierNode.getLiteralValue();
    if (!specifiers.has(specifier)) continue;
    if (Node.isCallExpression(node)) out.push({ node, specifier });
    for (const name of boundNames(node)) bound.set(name.getSymbolOrThrow().compilerSymbol, specifier);
  }
  if (bound.size > 0) {
    for (const id of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const specifier = bound.get(id.getSymbol()?.compilerSymbol);
      if (specifier !== undefined && !id.getFirstAncestor((a) => Node.isImportDeclaration(a) || Node.isImportEqualsDeclaration(a))) out.push({ node: id, specifier });
    }
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
