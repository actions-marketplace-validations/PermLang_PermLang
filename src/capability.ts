// The capability vocabulary and the rules for when a declared permission covers
// an actual use. Names are language-neutral so future analyzers can share them.
// Adapter manifests extend the vocabulary with app-level names like email.send.

import path from "node:path";

export const BUILTIN_CAPABILITIES: readonly string[] = ["net", "fs.read", "fs.write", "db.read", "db.write", "env", "exec"];

export const BUILTIN_VOCABULARY: ReadonlySet<string> = new Set(BUILTIN_CAPABILITIES);

/**
 * Code whose effects can't be determined statically (eval, a computed call on a
 * sensitive object, require). It can't be declared in @perm: the only way to
 * accept it is @perm-unsafe, which stops it from failing callers.
 */
export const UNVERIFIABLE = "unverifiable";

/**
 * A capability with an optional scope. A missing `arg` means "any": as a
 * declaration it allows every host, path, table, or variable.
 */
export interface Capability {
  name: string;
  arg?: string;
  /** On an actual use: the scope exists but could not be determined statically. */
  dynamic?: boolean;
}

export interface PermListError {
  /** The offending entry as written, or "@perm" when the tag is empty. */
  text: string;
  reason: string;
  /** Offset of the entry within the parsed text. */
  offset: number;
}

const NO_ARGUMENT: ReadonlySet<string> = new Set(["exec"]);
export const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/i;
const ENTRY = /^([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)(?:\(([^()]*)\))?$/i;

export function formatCapability(c: Capability): string {
  return c.arg === undefined ? c.name : `${c.name}(${c.arg})`;
}

/** Parses the body of a `@perm` tag, e.g. `net(api.stripe.com), env(STRIPE_KEY)`. */
export function parsePermList(
  text: string,
  vocabulary: ReadonlySet<string> = BUILTIN_VOCABULARY,
): { capabilities: Capability[]; errors: PermListError[] } {
  const capabilities: Capability[] = [];
  const errors: PermListError[] = [];

  if (text.trim() === "") {
    return { capabilities, errors: [{ text: "@perm", reason: "empty @perm tag; list at least one capability", offset: 0 }] };
  }

  for (const { entry, offset } of splitEntries(text)) {
    const fail = (reason: string) => errors.push({ text: entry, reason, offset });

    if (entry === "") {
      errors.push({ text: ",", reason: "empty entry between commas", offset });
      continue;
    }
    if (entry.includes("*")) {
      fail("wildcards are not allowed; list each capability explicitly");
      continue;
    }
    const match = ENTRY.exec(entry);
    if (!match) {
      fail("malformed capability; expected name or name(argument)");
      continue;
    }
    const [, name, arg] = match as unknown as [string, string, string | undefined];
    if (!vocabulary.has(name)) {
      fail(`unknown capability "${name}"; app-level capabilities need an adapter manifest`);
      continue;
    }
    if (arg !== undefined && NO_ARGUMENT.has(name)) {
      fail(`${name} takes no argument`);
      continue;
    }
    if (arg !== undefined && arg.trim() === "") {
      fail(`empty argument; write ${name}(...) with a value`);
      continue;
    }
    capabilities.push({ name, arg: arg?.trim() });
  }

  return { capabilities, errors };
}

/** Splits on commas outside parentheses, keeping each trimmed entry's offset. */
function splitEntries(text: string): { entry: string; offset: number }[] {
  const entries: { entry: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    entries.push({ entry: raw.trim(), offset: raw.trim() === "" ? start : start + lead });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return entries;
}

/** True when any declared capability allows the actual use. */
export function covers(declared: readonly Capability[], actual: Capability): boolean {
  return declared.some((d) => d.name === actual.name && argCovers(d.name, d.arg, actual.arg));
}

function argCovers(name: string, declared: string | undefined, actual: string | undefined): boolean {
  if (declared === undefined) return true;
  if (actual === undefined) return false;
  if (name === "net") return declared.toLowerCase() === actual.toLowerCase();
  if (name === "fs.read" || name === "fs.write") return pathCovers(declared, actual);
  return declared === actual;
}

function pathCovers(declared: string, actual: string): boolean {
  const d = parsePath(declared);
  const a = parsePath(actual);
  // Paths under different roots never cover each other: where a relative path falls under an
  // absolute one depends on where the program runs, and `\\server\share` isn't under `/server`.
  if (d.root !== a.root) return false;
  const ds = d.segments;
  const as = a.segments;
  const up = (s: string[]) => s.filter((x) => x === "..").length;
  // `.`, `..`, `../..`: the working directory or a folder above it, which also holds paths
  // that climb fewer levels. `..` covers `a` and `../b`, but not `../../c`.
  if (up(ds) === ds.length) return up(as) <= ds.length;
  return as.length >= ds.length && ds.every((s, i) => as[i] === s);
}

/**
 * A path's root and its segments, with forward slashes and `..` resolved. The root is one of:
 * `""` (relative), `/`, a Windows drive (`C:/`), a network share (`//`, followed by the server
 * and share as the first segments), or a drive-relative path's drive (`C:`, for `C:x`, which is
 * relative to drive C's own working directory, not the program's). Below an absolute root, `..`
 * can't climb further; in a relative path, it only appears at the start.
 */
function parsePath(p: string): { root: string; segments: string[] } {
  const slashed = p.replaceAll("\\", "/");
  const root = /^(\/\/|[A-Za-z]:\/?|\/)/.exec(slashed)?.[0] ?? "";
  const rest = slashed.slice(root.length);
  const absolute = root.endsWith("/");
  const normalized = path.posix.normalize(absolute ? `/${rest}` : rest);
  return {
    // Drive letters are case-insensitive.
    root: root.toUpperCase(),
    segments: normalized.split("/").filter((s) => s !== "" && s !== "."),
  };
}
