// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Walking a syntax tree without recursion, and finding positions in it quickly.
//
// ts-morph's own traversals (forEachDescendant, getDescendantsOfKind) recurse once per
// level of nesting, so a valid but deeply nested expression, such as a 3,000-term string
// concatenation, overflows the stack. These keep their own stack instead, and visit nodes
// parents first, so wrapping a node never has to wrap its ancestors recursively either.
// A file's nodes are listed once, and reused by every pass over it.

import { type KindToNodeMappings, type Node, type SourceFile, type SyntaxKind, type ts } from "ts-morph";

interface Index {
  all: Node[];
  byKind: Map<SyntaxKind, Node[]>;
}

// Keyed by the compiler's node, which is replaced when the file is edited.
const indexes = new WeakMap<ts.SourceFile, Index>();

/** Calls `visit` on every node in a file, in source order, parents first. */
export function forEachDescendant(sourceFile: SourceFile, visit: (node: Node) => void): void {
  for (const node of indexOf(sourceFile).all) visit(node);
}

/** Every node of `kind` in a file, in source order. */
export function descendantsOfKind<K extends SyntaxKind>(sourceFile: SourceFile, kind: K): KindToNodeMappings[K][] {
  return (indexOf(sourceFile).byKind.get(kind) ?? []) as KindToNodeMappings[K][];
}

function indexOf(sourceFile: SourceFile): Index {
  const known = indexes.get(sourceFile.compilerNode);
  if (known) return known;
  const index: Index = { all: [], byKind: new Map() };
  walk(sourceFile, (node) => {
    index.all.push(node);
    const list = index.byKind.get(node.getKind());
    if (list) list.push(node);
    else index.byKind.set(node.getKind(), [node]);
  });
  indexes.set(sourceFile.compilerNode, index);
  return index;
}

function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [];
  pushChildren(root, stack);
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    pushChildren(node, stack);
  }
}

function pushChildren(node: Node, stack: Node[]): void {
  const children: Node[] = [];
  // A callback that returns a value stops forEachChild, so this one returns nothing.
  node.forEachChild((child) => {
    children.push(child);
  });
  for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
}

// --- positions ---------------------------------------------------------------

interface Lines {
  /** Where each line starts: after each \n. */
  lines: number[];
  /** Where columns are counted from: after each \n or \r, as ts-morph does. */
  columns: number[];
}

const lineIndexes = new WeakMap<ts.SourceFile, Lines>();

/**
 * The line and column (both from 1) of a position, as ts-morph's getLineAndColumnAtPos
 * gives them. ts-morph counts the line breaks before the position on every call, which
 * is slow in a file with thousands of functions; this looks them up.
 */
export function lineAndColumn(sourceFile: SourceFile, pos: number): { line: number; column: number } {
  let index = lineIndexes.get(sourceFile.compilerNode);
  if (!index) {
    const text = sourceFile.getFullText();
    index = { lines: [0], columns: [0] };
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) index.lines.push(i + 1);
      if (c === 10 || c === 13) index.columns.push(i + 1);
    }
    lineIndexes.set(sourceFile.compilerNode, index);
  }
  const line = lastAtOrBefore(index.lines, pos);
  return { line: line + 1, column: pos - index.columns[lastAtOrBefore(index.columns, pos)]! + 1 };
}

/** The index of the last entry of a sorted list that is at most `pos`. */
function lastAtOrBefore(sorted: readonly number[], pos: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (sorted[mid]! <= pos) low = mid;
    else high = mid - 1;
  }
  return low;
}
