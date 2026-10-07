// Code PermLang can't see into: a package called with no adapter (PERM006), and an import whose
// types can't be found (PERM007). Both are trusted, with a warning, so new code of either kind
// could do anything without adding a capability to the lock. The lock records them too, in one
// entry next to the settings: a new one fails the check (PERM005) until `permlang lock` records
// it, like new access, and the pull-request comment lists it under "New code PermLang can't check".
//
//   permlang.config.json#<unchecked>
//     unchecked.import(src/telemetry.cjs)   an import with no types: a file by its path from the lock's
//     unchecked.import(left-pad)            folder, anything else as written
//     unchecked.package(leftpad2)           a package called with no adapter

import path from "node:path";
import type { FunctionReport, Report } from "./check.js";
import { isRelative } from "./unmapped.js";

/** The entry's name, after the config file's path in its lock key. */
const NAME = "<unchecked>";

/**
 * The lock entry for the code a report couldn't check, keyed by `file` (the config file). Each
 * capability's site is where it's first imported or called, so an error about it lands there.
 */
export function uncheckedEntry(report: Report, file: string, root: string): FunctionReport {
  const found = new Map<string, { file: string; line: number }>();
  // Reports made without the CLI may not say where; the imports are still recorded, as written.
  const imports = report.unresolvedImports ?? report.unresolved.map((specifier) => ({ specifier, file, line: 1 }));
  for (const u of imports) {
    const target = isRelative(u.specifier) ? relative(root, path.resolve(path.dirname(u.file), u.specifier)) : u.specifier;
    const capability = `unchecked.import(${target})`;
    if (!found.has(capability)) found.set(capability, u);
  }
  for (const u of report.unmapped) found.set(`unchecked.package(${u.package})`, u);
  const actual = [...found.keys()].sort();
  const at = (c: string) => found.get(c)!;
  return {
    file: path.resolve(file),
    name: NAME,
    line: 1,
    annotated: false,
    declared: [],
    actual,
    via: Object.fromEntries(actual.map((c) => [c, [`${relative(root, at(c).file)}:${at(c).line}`]])),
    sites: Object.fromEntries(actual.map((c) => [c, { line: at(c).line, column: 1, file: path.resolve(at(c).file) }])),
    kind: "config",
  };
}

/** The lock key of the entry above. */
export function isUncheckedKey(key: string): boolean {
  return key.endsWith(`#${NAME}`);
}

/** What a capability of that entry names, and whether it's an import or a package. */
export function uncheckedCode(capability: string): { kind: "import" | "package"; target: string } {
  const kind = capability.startsWith("unchecked.import(") ? "import" : "package";
  return { kind, target: capability.slice(capability.indexOf("(") + 1, capability.endsWith(")") ? -1 : undefined) };
}

/** "an import with no types", "a package with no adapter". */
export function uncheckedWhat(capability: string): string {
  return uncheckedCode(capability).kind === "import" ? "an import with no types" : "a package with no adapter";
}

function relative(root: string, file: string): string {
  return path.relative(root, path.resolve(file)).replaceAll("\\", "/");
}
