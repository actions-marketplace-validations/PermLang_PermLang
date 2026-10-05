// permlang.lock.json records what every function can reach. It is committed, so
// new access shows up as a change to the lock in the pull request's own diff,
// and `permlang check` fails when code and lock disagree (the approach capcheck
// uses for Go). `permlang lock` rewrites it.
//
//   {
//     "permlang": 1,
//     "functions": { "src/leads.ts#handleLead": ["db.write(lead)", "email.send"] },
//     "unsafe": { "src/render.ts#compile": "template compiler; trusted input" }
//   }
//
// Keys are `<path relative to the lock file>#<function name>`, with `#2`, `#3`
// appended when a file has several functions of the same name. Line numbers are
// left out so that moving code doesn't change the lock.

import path from "node:path";
import type { Diagnostic, Report } from "./check.js";

export interface LockFile {
  permlang: 1;
  /** Each function's actual permissions, sorted. Functions that reach nothing are left out. */
  functions: Record<string, string[]>;
  /** Functions with @perm-unsafe, and the reason given. */
  unsafe: Record<string, string>;
}

export class LockError extends Error {}

export function buildLock(report: Report, root: string): LockFile {
  const functions: Record<string, string[]> = {};
  for (const { key, fn } of keyed(report, root)) {
    if (fn.actual.length > 0) functions[key] = [...fn.actual].sort();
  }
  const unsafe: Record<string, string> = {};
  const keys = new Map(keyed(report, root).map(({ key, fn }) => [`${fn.file}\0${fn.line}\0${fn.name}`, key]));
  for (const u of report.unsafe) {
    const fn = report.functions.find((f) => f.file === u.file && f.name === u.function);
    const key = fn ? keys.get(`${fn.file}\0${fn.line}\0${fn.name}`) : undefined;
    unsafe[key ?? `${relative(root, u.file)}#${u.function}`] = u.reason;
  }
  return { permlang: 1, functions: sortKeys(functions), unsafe: sortKeys(unsafe) };
}

/** Each reported function with its lock key; same-named functions in a file are numbered in source order. */
export function keyed(report: Report, root: string): { key: string; fn: Report["functions"][number] }[] {
  const seen = new Map<string, number>();
  return [...report.functions]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((fn) => {
      const base = `${relative(root, fn.file)}#${fn.name}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { key: n === 1 ? base : `${base}#${n}`, fn };
    });
}

export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify({ permlang: 1, functions: sortKeys(lock.functions), unsafe: sortKeys(lock.unsafe) }, null, 2)}\n`;
}

/** @throws LockError when the file isn't a valid lock. */
export function parseLock(text: string, source: string): LockFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new LockError(`${source}: not valid JSON (${(e as Error).message}). Run \`permlang lock\` to regenerate it.`);
  }
  const m = raw as { permlang?: unknown; functions?: unknown; unsafe?: unknown };
  if (typeof raw !== "object" || raw === null) throw new LockError(`${source}: a lock file must be a JSON object.`);
  if (m.permlang !== 1) throw new LockError(`${source}: unsupported lock file version ${JSON.stringify(m.permlang)}; expected 1.`);

  const functions: Record<string, string[]> = {};
  for (const [key, caps] of Object.entries((m.functions ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) {
      throw new LockError(`${source}: "${key}" must list capabilities as an array of strings.`);
    }
    functions[key] = [...caps].sort();
  }
  const unsafe: Record<string, string> = {};
  for (const [key, reason] of Object.entries((m.unsafe ?? {}) as Record<string, unknown>)) {
    if (typeof reason !== "string") throw new LockError(`${source}: unsafe entry "${key}" must be a reason string.`);
    unsafe[key] = reason;
  }
  return { permlang: 1, functions: sortKeys(functions), unsafe: sortKeys(unsafe) };
}

/**
 * Where the code and the committed lock disagree. New access is an error: it
 * hasn't been reviewed. Access the lock records but the code no longer has is a
 * warning: the lock is stale, but nothing new can happen.
 */
export function lockDrift(committed: LockFile, current: LockFile, report: Report, lockFile: string): Diagnostic[] {
  const root = path.dirname(lockFile);
  const lockName = path.basename(lockFile);
  const locations = new Map(keyed(report, root).map(({ key, fn }) => [key, fn]));
  const out: Diagnostic[] = [];
  const fix = "run `permlang lock` and commit the change so reviewers see it.";
  // Locks written before PermLang recorded configuration (0.3) have none of it. Its first
  // appearance is reported, but doesn't fail the build: nothing in it is new.
  const configRecorded = Object.keys(committed.functions).some(isConfigKey);

  for (const change of diffLocks(committed, current).functions) {
    const fn = locations.get(change.key);
    const at = fn ? { file: fn.file, line: fn.line } : { file: lockFile, line: 1 };
    const config = isConfigKey(change.key);
    for (const capability of change.added) {
      // At the line that reaches it, so the error (and its pull-request annotation) lands on the change.
      const site = fn?.sites[capability];
      const unrecorded = config && !configRecorded;
      out.push({
        severity: unrecorded ? "warning" : "error",
        code: "PERM005",
        ...at,
        ...(site ? { line: site.line } : {}),
        column: site?.column ?? 1,
        function: change.name,
        capability,
        call: "",
        message: unrecorded
          ? `${lockName} doesn't record project configuration yet (PermLang 0.3 adds it): ${change.file} grants ${capability}.`
          : config
            ? `${change.file} now grants ${capability}, which ${lockName} doesn't record.`
            : `${change.name} can now reach ${capability}, which ${lockName} doesn't record.`,
        fix,
      });
    }
    for (const capability of change.removed) {
      out.push({
        severity: "warning",
        code: "PERM005",
        ...at,
        column: 1,
        function: change.name,
        capability,
        call: "",
        message: config
          ? `${change.file} ${change.status === "removed" ? "no longer exists or" : "no longer"} grants ${capability}, but ${lockName} still records it.`
          : `${change.name} ${change.status === "removed" ? "no longer exists or" : "no longer"} reaches ${capability}, but ${lockName} still records it.`,
        fix,
      });
    }
  }
  return out;
}

// --- diff --------------------------------------------------------------------

export interface FunctionChange {
  key: string;
  file: string;
  name: string;
  status: "added" | "removed" | "changed";
  added: string[];
  removed: string[];
}

/** A configuration file's entry (`.github/workflows/ci.yml#<ci.yml>`), not a function's. */
export function isConfigKey(key: string): boolean {
  return /#<[^<>#]+\.(?:ya?ml|json)>$/.test(key);
}

export interface LockDiff {
  functions: FunctionChange[];
  unsafeAdded: { key: string; reason: string }[];
  unsafeRemoved: { key: string; reason: string }[];
}

/** What changed between two locks. A missing base means everything in head is new. */
export function diffLocks(base: LockFile | undefined, head: LockFile): LockDiff {
  const before = base?.functions ?? {};
  const after = head.functions;
  const functions: FunctionChange[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = new Set(before[key] ?? []);
    const now = new Set(after[key] ?? []);
    const added = [...now].filter((c) => !was.has(c)).sort();
    const removed = [...was].filter((c) => !now.has(c)).sort();
    if (added.length === 0 && removed.length === 0) continue;
    const status = !(key in before) ? "added" : !(key in after) ? "removed" : "changed";
    const [file, name] = splitKey(key);
    functions.push({ key, file, name, status, added, removed });
  }
  const beforeUnsafe = base?.unsafe ?? {};
  return {
    functions,
    unsafeAdded: Object.entries(head.unsafe).filter(([k]) => !(k in beforeUnsafe)).map(([key, reason]) => ({ key, reason })),
    unsafeRemoved: Object.entries(beforeUnsafe).filter(([k]) => !(k in head.unsafe)).map(([key, reason]) => ({ key, reason })),
  };
}

/** "src/a.ts#Class.method#2" → ["src/a.ts", "Class.method"]. */
export function splitKey(key: string): [string, string] {
  const i = key.indexOf("#");
  return [key.slice(0, i), key.slice(i + 1).replace(/#\d+$/, "")];
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replaceAll("\\", "/");
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
