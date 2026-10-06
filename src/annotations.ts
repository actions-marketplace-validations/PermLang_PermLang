// Reads `@perm` tags from JSDoc comments.
//
// The raw comment text is scanned instead of relying on the TypeScript JSDoc
// parser, so tags like `@perm-unsafe` or `@permissions` are never mistaken for
// `@perm`, and every entry keeps an exact source position.

import { ts, type Node, type SourceFile } from "ts-morph";
import { parsePermList, type Capability } from "./capability.js";
import { forEachDescendant, lineAndColumn } from "./walk.js";

export interface AnnotationError {
  text: string;
  reason: string;
  line: number;
  column: number;
}

/** A `@perm-unsafe reason:"..."` tag: the function's own checks are suppressed. */
export interface UnsafeOverride {
  reason: string;
  line: number;
  column: number;
}

export interface PermAnnotation {
  capabilities: Capability[];
  errors: AnnotationError[];
  unsafe?: UnsafeOverride;
}

/** A comment's full text (including delimiters) and its start position in the file. */
export interface Comment {
  text: string;
  start: number;
}

const PERM_TAG = /@perm(?![\w-])/g;
const UNSAFE_TAG = /@perm-unsafe(?![\w-])/g;
const UNSAFE_REASON = /^\s*reason:\s*"([^"]*)"/;
const NEXT_TAG = /\s@[A-Za-z]/;
// A line break plus the comment's leading `*`, replaced by spaces so offsets stay exact.
const CONTINUATION = /\n[ \t]*\*(?!\/)/g;
// Standard JSDoc markers for a file-level comment.
const MODULE_TAG = /@(?:module|file|fileoverview)(?![\w-])/g;
// A block tag starts a line: nothing before it but the comment opener or leading `*`,
// or a bare file-level marker, as in the one-line `/** @module @perm net */`.
const LINE_START = /(?:^|\n)[ \t]*(?:\/\*\*)?[ \t]*\*?[ \t]*(?:@(?:module|file|fileoverview)[ \t]+)*$/;

/** Matches of `tag` that begin a line, so prose that mentions a tag (a `@perm` tag) is ignored. */
function blockTags(text: string, tag: RegExp): RegExpExecArray[] {
  return [...text.matchAll(tag)].filter((m) => LINE_START.test(text.slice(0, m.index)));
}

export function isModuleComment(text: string): boolean {
  return text.startsWith("/**") && blockTags(text, MODULE_TAG).length > 0;
}

/** A function's own JSDoc comments, excluding a module comment that happens to sit above it. */
export function functionComments(docs: readonly Comment[]): Comment[] {
  return docs.filter((c) => !isModuleComment(c.text));
}

/** The JSDoc comments TypeScript attaches to a node (any kind of node, not only those ts-morph calls JSDocable). */
export function jsDocComments(node: { compilerNode: ts.Node; getSourceFile(): SourceFile }): Comment[] {
  const sf = node.getSourceFile().compilerNode;
  return ((node.compilerNode as { jsDoc?: ts.JSDoc[] }).jsDoc ?? []).map((d) => ({ text: d.getText(sf), start: d.getStart(sf) }));
}

/** Every `@module` comment before a top-level statement (or at the end of the file). */
export function moduleComments(sourceFile: SourceFile): Comment[] {
  const text = sourceFile.getFullText();
  const positions = [...sourceFile.getStatements().map((s) => s.getPos()), sourceFile.compilerNode.endOfFileToken.pos];
  const seen = new Set<number>();
  const comments: Comment[] = [];
  for (const pos of positions) {
    for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) {
      const body = text.slice(range.pos, range.end);
      if (seen.has(range.pos) || !isModuleComment(body)) continue;
      seen.add(range.pos);
      comments.push({ text: body, start: range.pos });
    }
  }
  return comments;
}

/**
 * Merges every `@perm` and `@perm-unsafe` tag across the given comments;
 * undefined when there are none. `vocabulary` is the set of known capability
 * names: the built-ins plus whatever the loaded adapters define.
 */
export function readPermAnnotation(
  comments: readonly Comment[],
  sourceFile: SourceFile,
  vocabulary: ReadonlySet<string>,
): PermAnnotation | undefined {
  let found = false;
  const capabilities: Capability[] = [];
  const errors: AnnotationError[] = [];
  let unsafe: UnsafeOverride | undefined;
  const at = (pos: number) => lineAndColumn(sourceFile, pos);

  for (const { text, start } of comments) {
    for (const tag of blockTags(text, PERM_TAG)) {
      found = true;
      const bodyStart = tag.index + tag[0].length;
      const parsed = parsePermList(tagBody(text.slice(bodyStart)), vocabulary);
      capabilities.push(...parsed.capabilities);

      for (const e of parsed.errors) {
        // An empty tag is reported at the tag itself.
        const pos = e.text === "@perm" ? start + tag.index : start + bodyStart + e.offset;
        errors.push({ text: e.text, reason: e.reason, ...at(pos) });
      }
    }

    for (const tag of blockTags(text, UNSAFE_TAG)) {
      found = true;
      const reason = UNSAFE_REASON.exec(tagBody(text.slice(tag.index + tag[0].length)))?.[1]?.trim();
      if (reason) {
        unsafe ??= { reason, ...at(start + tag.index) };
      } else {
        errors.push({
          text: "@perm-unsafe",
          reason: '@perm-unsafe needs a reason, e.g. @perm-unsafe reason:"wraps a legacy SDK"',
          ...at(start + tag.index),
        });
      }
    }
  }

  return found ? { capabilities, errors, ...(unsafe ? { unsafe } : {}) } : undefined;
}

/**
 * `@perm` and `@perm-unsafe` tags in JSDoc comments that no function or file took, so
 * nothing checks them: on an interface member, a variable that isn't a function, a class
 * with a constructor, a statement. `consumed` holds the start of every comment that was read.
 */
export function strayPermTags(sourceFile: SourceFile, consumed: ReadonlySet<number>): { error: AnnotationError; node: Node }[] {
  const out: { error: AnnotationError; node: Node }[] = [];
  const seen = new Set<number>();
  forEachDescendant(sourceFile, (node) => {
    for (const doc of (node.compilerNode as { jsDoc?: ts.JSDoc[] }).jsDoc ?? []) {
      const start = doc.getStart(sourceFile.compilerNode);
      if (consumed.has(start) || seen.has(start)) continue;
      seen.add(start);
      const text = doc.getText(sourceFile.compilerNode);
      for (const [tag, pattern] of [["@perm", PERM_TAG], ["@perm-unsafe", UNSAFE_TAG]] as const) {
        for (const m of blockTags(text, pattern)) {
          out.push({ error: { text: tag, reason: "it applies to nothing", ...lineAndColumn(sourceFile, start + m.index) }, node });
        }
      }
    }
  });
  return out;
}

/** The text of one tag: up to the next tag or the end of the comment. */
function tagBody(rest: string): string {
  const close = rest.lastIndexOf("*/");
  let end = close === -1 ? rest.length : close;
  const next = NEXT_TAG.exec(rest);
  if (next && next.index < end) end = next.index;
  return rest.slice(0, end).replace(CONTINUATION, (m) => " ".repeat(m.length));
}
