// package.json scripts, the root's and every workspace package's: npm, Yarn, pnpm and
// Bun run a workspace package's install hooks (`preinstall`, `postinstall`, ...) when
// the root is installed. Workspaces are listed in package.json's `workspaces` (npm,
// Yarn, Bun) or in pnpm-workspace.yaml, as folder patterns. pnpm also reads a package's
// scripts from package.yaml or package.json5.
/**
 * @module
 * @perm fs.read
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSeq } from "yaml";
import type { Sink } from "./project-files.js";
import { YamlFile } from "./yaml-nodes.js";

/** The file names a package's scripts can be in. */
export const MANIFESTS = ["package.json", "package.json5", "package.yaml"];

/** Every package, when PermLang can't tell which are workspaces; pnpm's default too. */
export const EVERY_PACKAGE = ["**"];

/** Records a manifest's scripts. Returns the workspace patterns a package.json lists. */
export function readManifest(name: string, text: string, sink: Sink): string[] {
  text = text.replace(/^\uFEFF/, "");
  if (name === "package.yaml") return readYamlManifest(text, sink);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Also package.json5, unless it's plain JSON: PermLang doesn't parse JSON5.
    parsed = undefined;
  }
  // A package manager reads only an object; anything else is a file PermLang can't vouch for.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sink.unverifiable(`a ${name} PermLang can't read`, { line: 1, column: 1 });
    return [];
  }
  const pkg = parsed as { scripts?: unknown; workspaces?: unknown };
  const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
  const from = Math.max(0, text.indexOf('"scripts"'));
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    const key = text.indexOf(`${JSON.stringify(script)}`, from);
    const before = text.slice(0, Math.max(0, key));
    const line = before.split("\n").length;
    const column = key - (before.lastIndexOf("\n") + 1) + 1;
    sink.add(`npm.script(${script}: ${command})`, `"${script}": ${JSON.stringify(command)}`, { line, column });
  }
  return name === "package.json" ? workspacePatterns(pkg.workspaces, sink) : [];
}

/** `workspaces`: a list of patterns, or Yarn's and Bun's `{ packages: [...] }`. */
function workspacePatterns(workspaces: unknown, sink: Sink): string[] {
  if (workspaces === undefined) return [];
  const list = Array.isArray(workspaces) ? workspaces : typeof workspaces === "object" && workspaces !== null ? ((workspaces as { packages?: unknown }).packages ?? []) : undefined;
  if (Array.isArray(list) && list.every((p) => typeof p === "string")) return list as string[];
  sink.unverifiable("workspaces: a list PermLang can't read, so every package's scripts are recorded", { line: 1, column: 1 });
  return EVERY_PACKAGE;
}

function readYamlManifest(text: string, sink: Sink): string[] {
  const yaml = new YamlFile(text);
  if (!yaml.readable || yaml.problems.length > 0) {
    sink.unverifiable("a package.yaml PermLang can't read", { line: 1, column: 1 });
    return [];
  }
  for (const scripts of yaml.get(yaml.root(), "scripts")) {
    for (const script of yaml.fields(scripts)) {
      const command = yaml.text(script.value.node);
      if (command !== undefined) sink.add(`npm.script(${script.key}: ${command})`, `${script.key}: ${command}`, script.at);
    }
  }
  return [];
}

/** The workspace patterns pnpm-workspace.yaml lists: its `packages`, or every package when it has none. */
export function readPnpmWorkspace(text: string, sink: Sink): string[] {
  const yaml = new YamlFile(text);
  const empty = yaml.doc.errors.length === 0 && yaml.doc.contents === null;
  if (empty) return EVERY_PACKAGE;
  if (!yaml.readable || yaml.problems.length > 0) {
    // pnpm can't install either; recording every package's scripts meanwhile means none is missed.
    sink.unverifiable("a pnpm-workspace.yaml PermLang can't read, so every package's scripts are recorded", { line: 1, column: 1 });
    return EVERY_PACKAGE;
  }
  const lists = yaml.get(yaml.root(), "packages").filter((list) => yaml.text(list.node) !== "");
  if (lists.length === 0) return EVERY_PACKAGE;
  const patterns = lists.flatMap((list) => (isSeq(list.node) ? yaml.items(list).map((item) => yaml.text(item.node)) : [undefined]));
  if (patterns.every((p) => p !== undefined)) return patterns;
  sink.unverifiable("packages: a list PermLang can't read, so every package's scripts are recorded", lists[0]!.at);
  return EVERY_PACKAGE;
}

// --- Matching folders ---------------------------------------------------------------

/** Folders the package managers never look in for workspace packages. */
const SKIPPED = new Set(["node_modules", "bower_components", ".git"]);

/**
 * The folders that workspace patterns select, as npm, Yarn and pnpm match them: `*`
 * and `?` within a folder name, `**` for any depth, `{a,b}` for either, and `!` to
 * leave folders out. Syntax beyond that (`+(a|b)`) matches any name, so it can only
 * select more; an exclusion written with it is ignored.
 */
export function workspaceFolders(root: string, patterns: string[]): string[] {
  const included = patterns.filter((p) => !p.startsWith("!")).flatMap((p) => parsePattern(p, true));
  const excluded = patterns.filter((p) => p.startsWith("!")).flatMap((p) => parsePattern(p.slice(1), false));
  const found = new Set<string>();
  for (const pattern of included) {
    for (const dir of folders(path.resolve(root, pattern.base), pattern.depth)) {
      const relative = path.relative(root, dir).split(path.sep).join("/") || ".";
      if (pattern.regex.test(relative) && !excluded.some((e) => e.regex.test(relative))) found.add(dir);
    }
  }
  return [...found].sort();
}

interface Pattern {
  /** The folder the pattern starts in: its segments before the first wildcard. */
  base: string;
  /** How many folders deep below `base` it can match. */
  depth: number;
  regex: RegExp;
}

function parsePattern(raw: string, including: boolean): Pattern[] {
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/")).replace(/\/+$/, "");
  // An absolute pattern selects nothing: pnpm matches paths relative to the root.
  if (normalized.startsWith("/")) return [];
  const segments = normalized.split("/");
  let regex = "^";
  let separator = "";
  for (const [i, segment] of segments.entries()) {
    if (segment === "**") {
      regex += i === segments.length - 1 ? (i === 0 ? ".*" : "(?:/.*)?") : `${separator}(?:[^/]+/)*`;
      separator = "";
      continue;
    }
    const part = segmentRegex(segment);
    if (part === undefined && !including) return [];
    regex += separator + (part ?? "[^/]*");
    separator = "/";
  }
  const literal = segments.findIndex((s) => /[*?{[(|]/.test(s));
  const base = literal === -1 ? segments : segments.slice(0, literal);
  const depth = segments.includes("**") ? Infinity : segments.length - base.length;
  return [{ base: base.join("/") || ".", depth, regex: new RegExp(`${regex}$`) }];
}

/** One folder name's pattern as a regular expression, or undefined for syntax this doesn't read. */
function segmentRegex(segment: string): string | undefined {
  // Extended globs: @(a|b), +(a), !(a), and the like.
  if (/[()|]/.test(segment)) return undefined;
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = segment.indexOf("}", i);
      if (end === -1) return undefined;
      out += `(?:${segment.slice(i + 1, end).split(",").map(escape).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = segment.indexOf("]", i);
      if (end === -1) return undefined;
      out += `[${segment.slice(i + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      i = end;
    } else out += escape(c);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * `dir` and the folders below it, up to `depth` deep, each once even through links. A
 * folder that can't be listed is skipped: no package manager can install from it either.
 */
function folders(dir: string, depth: number, seen = new Set<string>()): string[] {
  let real: string;
  let entries;
  try {
    if (!statSync(dir).isDirectory()) return [];
    real = realpathSync(dir);
    entries = depth === 0 ? [] : readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (seen.has(real)) return [];
  seen.add(real);
  const out = [dir];
  for (const entry of entries) {
    if ((entry.isDirectory() || entry.isSymbolicLink()) && !SKIPPED.has(entry.name)) out.push(...folders(path.join(dir, entry.name), depth - 1, seen));
  }
  return out;
}
