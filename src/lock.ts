// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// permlang.lock.json records what every function can reach, what the project's configuration
// grants, and the settings the check runs with. It is committed, so new access shows up as a
// change to the lock in the pull request's own diff, and `permlang check` fails when the code and
// the lock differ in any way (the approach capcheck uses for Go). `permlang lock` rewrites it.
//
//   {
//     "permlang": 2,
//     "functions": {
//       "permlang.config.json#<permlang.config.json>": ["permlang.files(src)", "permlang.strictness(development)", ...],
//       "permlang.config.json#<unchecked>": ["unchecked.package(kafkajs)"],
//       "src/leads.ts#handleLead": ["db.write(lead)", "email.send"]
//     },
//     "unsafe": { "src/render.ts#compile": "template compiler; trusted input" }
//   }
//
// Keys are `<path relative to the lock file>#<function name>`, with `#2`, `#3` appended when a
// file has several functions of the same name. A `#` or `%` in the path is percent-encoded, so
// the first `#` always ends it. Line numbers are left out so that moving code doesn't change the
// lock. Version 1 (PermLang 0.1 to 0.3) recorded no settings; it's read only so that
// `permlang lock` can replace it.

import path from "node:path";
import type { Diagnostic, Report } from "./check.js";
import { describeScope, isSetting, isSingleValued, scopeOf, settingKind, settingPhrase } from "./settings.js";
import { isUncheckedKey, uncheckedCode } from "./unchecked.js";

export const LOCK_VERSION = 2;

export interface LockFile {
  permlang: 1 | 2;
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
  for (const { key, u } of keyedUnsafe(report, root)) unsafe[key] = u.reason;
  return { permlang: LOCK_VERSION, functions: sortKeys(functions), unsafe: sortKeys(unsafe) };
}

/** Each reported function with its lock key; same-named functions in a file are numbered in source order. */
export function keyed(report: Report, root: string): { key: string; fn: Report["functions"][number] }[] {
  const seen = new Map<string, number>();
  return [...report.functions]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((fn) => {
      const base = `${keyPath(root, fn.file)}#${fn.name}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { key: n === 1 ? base : `${base}#${n}`, fn };
    });
}

/**
 * Each @perm-unsafe override with the key of the function it's on, so that two functions of the
 * same name get their own entries (`#2`), as they do in "functions". The tag is in the comment
 * just above its function: the first function of that name at or after the tag's line.
 */
function keyedUnsafe(report: Report, root: string): { key: string; u: Report["unsafe"][number] }[] {
  const functions = keyed(report, root).filter(({ fn }) => fn.kind !== "config");
  return report.unsafe.map((u) => {
    const match = functions.filter(({ fn }) => fn.file === u.file && fn.name === u.function && fn.line >= u.line).sort((a, b) => a.fn.line - b.fn.line)[0];
    return { key: match?.key ?? `${keyPath(root, u.file)}#${u.function}`, u };
  });
}

export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify({ permlang: LOCK_VERSION, functions: sortKeys(lock.functions), unsafe: sortKeys(lock.unsafe) }, null, 2)}\n`;
}

/**
 * Reads a lock file, version 1 or 2. Look its records up with own(): a key can be named
 * `toString` or `__proto__`, which a plain lookup would find on every object.
 * @throws LockError when the file isn't a valid lock.
 */
export function parseLock(text: string, source: string): LockFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\u{FEFF}/u, ""));
  } catch (e) {
    throw new LockError(`${source}: not valid JSON (${oneLine((e as Error).message)}). Run \`permlang lock\` to regenerate it.`);
  }
  if (!isRecord(raw)) throw new LockError(`${source}: a lock file must be a JSON object.`);
  const version = own(raw, "permlang");
  if (version !== 1 && version !== 2) {
    const shown = version === undefined ? "missing" : oneLine(JSON.stringify(version));
    throw new LockError(`${source}: lock file version ${shown} isn't one this PermLang reads (1 or 2). Run \`permlang lock\` to regenerate it.`);
  }
  const functions = Object.create(null) as Record<string, string[]>;
  for (const [key, caps] of Object.entries(record(own(raw, "functions"), `${source}: "functions"`))) {
    if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) {
      throw new LockError(`${source}: "${oneLine(key)}" must list capabilities as an array of strings.`);
    }
    functions[key] = [...caps].sort();
  }
  const unsafe = Object.create(null) as Record<string, string>;
  for (const [key, reason] of Object.entries(record(own(raw, "unsafe"), `${source}: "unsafe"`))) {
    if (typeof reason !== "string") throw new LockError(`${source}: unsafe entry "${oneLine(key)}" must be a reason string.`);
    unsafe[key] = reason;
  }
  return { permlang: version, functions: sortKeys(functions), unsafe: sortKeys(unsafe) };
}

/**
 * Where the code and the committed lock differ. Every difference is an error, because the lock is
 * what reviewers approve: new access hasn't been reviewed, and access the lock records but the
 * code doesn't reach would approve it in advance, for a later change to use unseen. The same goes
 * for @perm-unsafe overrides and their reasons, and for the settings the check runs with.
 *
 * @param current buildLock(report): what the code reaches now.
 * @param lockText the lock file's text, to point at the line of an entry only the lock has.
 */
export function lockDrift(committed: LockFile, current: LockFile, report: Report, lockFile: string, lockText = ""): Diagnostic[] {
  const root = path.dirname(lockFile);
  const lockName = path.basename(lockFile);
  const fix = "run `permlang lock` and commit the change so reviewers see it.";
  const uncheckedFix =
    "it could do anything: review what it runs, then run `permlang lock` and commit the change so reviewers see it. To have it checked instead, install its types, or add an adapter for it.";
  const settingsFix =
    "to make these the settings, run `permlang lock` with the same options and commit the change so reviewers see it. To try other settings without the lock, add --no-lock.";
  const inLock = (key: string, capability?: string, from = 0) => ({ file: lockFile, line: lineInLock(lockText, key, capability, from) ?? 1, column: 1 });
  const drift = (d: Omit<Diagnostic, "severity" | "code" | "call">): Diagnostic => ({ severity: "error", code: "PERM005", call: "", ...d });

  // A lock from before settings were recorded can't be compared: one error says what to do.
  if (committed.permlang !== LOCK_VERSION) {
    return [
      drift({
        ...inLock(""),
        function: "<lock>",
        capability: "",
        message: `${lockName} was written by an older PermLang (lock format ${committed.permlang}), which recorded less than this version checks.`,
        fix: "run `permlang lock` once to update it, and commit the change.",
      }),
    ];
  }

  // Checking other files than the lock was written for: comparing function by function would
  // only list everything that's in one set and not the other.
  const was = scopeOf(committed);
  const now = scopeOf(current);
  if (was.join("\0") !== now.join("\0")) {
    const settings = keyed(report, root).find(({ fn }) => fn.kind === "config" && fn.actual.some((c) => now.includes(c)));
    return [
      drift({
        ...(settings ? { file: settings.fn.file, line: 1, column: 1 } : inLock("")),
        function: settings?.fn.name ?? "<lock>",
        capability: now.join(", "),
        message: `This check ran on ${describeScope(now)}, but ${lockName} was written for ${describeScope(was)}.`,
        fix: "run the check on the same files, or run `permlang lock` on these and commit the change so reviewers see it.",
      }),
    ];
  }

  const locations = new Map(keyed(report, root).map(({ key, fn }) => [key, fn]));
  const changes = diffLocks(committed, current);
  const out: Diagnostic[] = [];
  for (const change of changes.functions) {
    const fn = locations.get(change.key);
    const config = isConfigKey(change.key);
    const unchecked = isUncheckedKey(change.key);
    const settings = config ? change.added.filter(isSetting) : [];
    const oldSettings = config ? change.removed.filter(isSetting) : [];
    // A setting with one value that changed: one error that gives both values.
    const paired = new Map<string, string>();
    for (const c of settings.filter(isSingleValued)) {
      const old = oldSettings.find((o) => settingKind(o) === settingKind(c));
      if (old) paired.set(c, old);
    }
    for (const capability of change.added) {
      // Added access is in `current`, so the report has it, and where it's reached: the error (and
      // its pull-request annotation) lands on the change.
      const { file, sites, via } = fn!;
      const site = sites[capability]!;
      const setting = settings.includes(capability);
      const old = paired.get(capability);
      const subject = `${settingSubject(change.file, capability)} ${settingPhrase(capability)}${setting ? origin(via[capability]![0]) : ""}`;
      // A file the checked files import isn't a setting to choose: recording it is all there is to do.
      const settingFix = setting && !isImported(capability);
      out.push(
        drift({
          // Code PermLang can't check is recorded where it's imported or called.
          file: site.file ?? file,
          line: site.line,
          column: site.column,
          function: change.name,
          capability,
          message: unchecked
            ? uncheckedMessage(capability, lockName, "new")
            : old
              ? `${subject}, but ${lockName} records ${settingPhrase(old)}.`
              : setting
                ? `${subject}, which ${lockName} doesn't record.`
                : config
                  ? `${change.file} now grants ${capability}, which ${lockName} doesn't record.`
                  : `${change.name} can now reach ${capability}, which ${lockName} doesn't record.`,
          fix: unchecked ? uncheckedFix : settingFix ? settingsFix : fix,
        }),
      );
    }
    for (const capability of change.removed) {
      if ([...paired.values()].includes(capability)) continue;
      const setting = oldSettings.includes(capability);
      const gone = change.status === "removed" ? "no longer exists or" : "no longer";
      out.push(
        drift({
          // On the lock's own line: a pull request that adds it there shows it there.
          ...inLock(change.key, capability),
          function: change.name,
          capability,
          message: unchecked
            ? uncheckedMessage(capability, lockName, "gone")
            : setting
              ? `${lockName} records ${settingPhrase(capability)}, which ${capability.startsWith("tsconfig.") ? `${change.file} no longer has` : isImported(capability) ? "the check no longer reads" : "the check no longer runs with"}.`
              : config
                ? `${change.file} ${gone} grants ${capability}, but ${lockName} still records it.`
                : `${change.name} ${gone} reaches ${capability}, but ${lockName} still records it.`,
          fix: setting && !isImported(capability) ? settingsFix : fix,
        }),
      );
    }
  }

  // @perm-unsafe overrides suppress checks, so each one is reviewed like new access.
  const overrides = new Map(keyedUnsafe(report, root).map(({ key, u }) => [key, u]));
  // At the tag in the code, or for one only the lock has, at its line in the lock.
  const atOverride = (key: string) => {
    const u = overrides.get(key);
    return u ? { file: u.file, line: u.line, column: 1 } : inLock(key, undefined, lockText.indexOf('"unsafe":'));
  };
  const override = (key: string, message: string) => drift({ ...atOverride(key), function: splitKey(key)[1], capability: "@perm-unsafe", message, fix });
  for (const { key, reason } of changes.unsafeAdded) {
    out.push(override(key, `${splitKey(key)[1]} has a new @perm-unsafe override (${JSON.stringify(reason)}), which ${lockName} doesn't record.`));
  }
  for (const { key, reason } of changes.unsafeRemoved) {
    out.push(override(key, `${lockName} records a @perm-unsafe override on ${splitKey(key)[1]} (${JSON.stringify(reason)}), which the code no longer has.`));
  }
  for (const { key, before, after } of changes.unsafeChanged) {
    out.push(override(key, `${splitKey(key)[1]}'s @perm-unsafe reason is now ${JSON.stringify(after)}, but ${lockName} records ${JSON.stringify(before)}.`));
  }
  return out;
}

/** "The check runs with" for PermLang's own settings; "tsconfig.json now has" for the project's. */
function settingSubject(file: string, capability: string): string {
  if (isImported(capability)) return "The check now also reads";
  return capability.startsWith("tsconfig.") ? `${file} now has` : "The check runs with";
}

/** Code PermLang can't check (unchecked.ts) that's new, or that the lock records and the code no longer has. */
function uncheckedMessage(capability: string, lockName: string, change: "new" | "gone"): string {
  const { kind, target } = uncheckedCode(capability);
  if (change === "new") return `PermLang can't check ${target}: ${kind === "import" ? "its types can't be found" : "it has no adapter"}, and ${lockName} doesn't record it.`;
  return `${lockName} records ${target} as code PermLang can't check, which the code no longer ${kind === "import" ? "imports" : "calls into"}.`;
}

/** A file the check read because a checked file imports it (`permlang.imported(lib/db.ts)`). */
function isImported(capability: string): boolean {
  return capability.startsWith("permlang.imported(");
}

/** Where a setting came from, when it isn't the config file: a command-line option, or the default. */
function origin(from: string | undefined): string {
  if (from?.startsWith("--")) return ` (from ${from})`;
  if (from === "default") return " (the default)";
  return "";
}

/**
 * The line of an entry in the lock file's text, if it's there: of the capability, when it's in the
 * entry's list (which serializeLock ends on a line of its own), else of the key.
 */
function lineInLock(text: string, key: string, capability: string | undefined, from: number): number | undefined {
  const at = text.indexOf(`${JSON.stringify(key)}:`, from);
  if (at === -1) return undefined;
  const within = capability === undefined ? -1 : text.indexOf(JSON.stringify(capability), at);
  const pos = within !== -1 && within < text.indexOf("\n    ]", at) ? within : at;
  return text.slice(0, pos).split("\n").length;
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

/**
 * A configuration file's entry (`.github/workflows/ci.yml#<ci.yml>`, `permlang.config.json#<permlang.config.json>`),
 * not a function's. File names can be in any case (`CI.YML`), and JSON5 or JSONC.
 */
export function isConfigKey(key: string): boolean {
  return /#<[^<>]+\.(?:ya?ml|json[5c]?)>$/i.test(key);
}

export interface LockDiff {
  functions: FunctionChange[];
  unsafeAdded: { key: string; reason: string }[];
  unsafeRemoved: { key: string; reason: string }[];
  /** Overrides whose reason changed. */
  unsafeChanged: { key: string; before: string; after: string }[];
}

/** What changed between two locks. A missing base means everything in head is new. */
export function diffLocks(base: LockFile | undefined, head: LockFile): LockDiff {
  const before = base?.functions ?? {};
  const after = head.functions;
  const functions: FunctionChange[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = new Set(own(before, key) ?? []);
    const now = new Set(own(after, key) ?? []);
    const added = [...now].filter((c) => !was.has(c)).sort();
    const removed = [...was].filter((c) => !now.has(c)).sort();
    if (added.length === 0 && removed.length === 0) continue;
    const status = !Object.hasOwn(before, key) ? "added" : !Object.hasOwn(after, key) ? "removed" : "changed";
    const [file, name] = splitKey(key);
    functions.push({ key, file, name, status, added, removed });
  }
  const beforeUnsafe = base?.unsafe ?? {};
  const afterUnsafe = head.unsafe;
  const entries = (r: Record<string, string>) => Object.entries(r).map(([key, reason]) => ({ key, reason }));
  return {
    functions,
    unsafeAdded: entries(afterUnsafe).filter(({ key }) => !Object.hasOwn(beforeUnsafe, key)),
    unsafeRemoved: entries(beforeUnsafe).filter(({ key }) => !Object.hasOwn(afterUnsafe, key)),
    unsafeChanged: entries(afterUnsafe).flatMap(({ key, reason }) => {
      const old = own(beforeUnsafe, key);
      return old !== undefined && old !== reason ? [{ key, before: old, after: reason }] : [];
    }),
  };
}

/** "src/a.ts#Class.method#2" → ["src/a.ts", "Class.method"]; "a%23b.ts#f" → ["a#b.ts", "f"]. */
export function splitKey(key: string): [string, string] {
  const i = key.indexOf("#");
  if (i === -1) return [key, key];
  const file = key.slice(0, i).replace(/%23|%25/gi, (e) => (e === "%23" ? "#" : "%"));
  return [file, key.slice(i + 1).replace(/#\d+$/, "")];
}

/** A record's own property, never one every object inherits, such as `toString`. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A file's path in a lock key: relative to the lock, with `/`, and `%` and `#` percent-encoded. */
function keyPath(root: string, file: string): string {
  return path.relative(root, file).replaceAll("\\", "/").replaceAll("%", "%25").replaceAll("#", "%23");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new LockError(`${what} must be an object.`);
  return value;
}

/** Text from the lock (an error message from JSON.parse can quote it), on one line. */
function oneLine(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}]/gu, " ");
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
