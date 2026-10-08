// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// What the check runs with, recorded in the lock. A pull request can loosen the check without
// touching code: lower the strictness, trust packages with no adapter, add an adapter that
// declares a package pure, drop a flow rule, narrow tsconfig.json's "include", or check other
// paths. So these are recorded like workflows and package.json scripts are (project-files.ts):
// as configuration entries whose capabilities are the settings. Changing one fails the check
// until `permlang lock` records it, and the pull-request comment lists it.
//
//   permlang.config.json#<permlang.config.json>
//     permlang.files(src)                       the paths checked, or permlang.project(tsconfig.json)
//     permlang.imported(lib/db.ts)              each file read only because a checked file imports it
//     permlang.strictness(development)          the settings in effect, command-line options included
//     permlang.unmapped(warn)
//     permlang.tools(warn)
//     permlang.flow(env(STRIPE_KEY) -> net(api.stripe.com))
//     permlang.adapter(permlang/adapters/acme.json sha256:0123456789abcdef)
//   tsconfig.json#<tsconfig.json>               when the files come from a TypeScript project
//     tsconfig.include(src)                     which files it selects, following "extends"
//     tsconfig.exclude(src/legacy)
//     tsconfig.paths(@app/* -> src/*)           and the options that decide what imports resolve to,
//     tsconfig.allowSyntheticDefaultImports(false)  some always, as TypeScript works them out
//
// The settings recorded are the ones in effect, so a --strictness option, or the Action's
// strictness input, counts as much as the config file: a workflow change can't loosen the
// check unseen either.
/**
 * @module
 * @perm fs.read
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import { formatCapability } from "./capability.js";
import type { FunctionReport } from "./check.js";
import { parseFlows, type FlowRule } from "./flows.js";
import type { LockFile } from "./lock.js";
import { printable } from "./report.js";

export const DEFAULT_CONFIG = "permlang.config.json";

/** A problem with the settings or the files they name: a usage error, exit code 2. */
export class SettingsError extends Error {}

/** permlang.config.json as written. The values of strictness, unmapped, and tools are checked by the caller. */
export interface ConfigFile {
  /** The file read, or undefined when there's none. */
  file?: string;
  strictness?: unknown;
  unmapped?: unknown;
  tools?: unknown;
  flows?: FlowRule[];
  /** Adapter manifests, resolved relative to the config file. */
  adapters: string[];
}

const SETTINGS = ["strictness", "unmapped", "tools", "adapters", "flows"];

/** permlang.config.json: the one given, else ./permlang.config.json if there is one. */
export function readConfig(explicit: string | undefined): ConfigFile {
  const file = explicit ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (file === undefined) return { adapters: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\u{FEFF}/u, ""));
  } catch (e) {
    throw new SettingsError(`Can't read ${file}: ${printable((e as Error).message)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SettingsError(`${file}: must be a JSON object.`);
  const config = raw as Record<string, unknown>;
  // A typo ("strictnes") would otherwise be ignored, leaving the default in place unseen.
  const unknown = Object.keys(config).find((k) => k !== "$schema" && !SETTINGS.includes(k));
  if (unknown !== undefined) throw new SettingsError(`${file}: unknown setting "${printable(unknown)}". Settings: ${SETTINGS.join(", ")}.`);
  const list = config.adapters ?? [];
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
    throw new SettingsError(`${file}: "adapters" must be a list of manifest paths.`);
  }
  let flows: FlowRule[] | undefined;
  try {
    flows = config.flows === undefined ? undefined : parseFlows(config.flows, file);
  } catch (e) {
    throw new SettingsError((e as Error).message);
  }
  return {
    file,
    adapters: list.map((a) => path.resolve(path.dirname(file), a)),
    ...(config.strictness !== undefined ? { strictness: config.strictness } : {}),
    ...(config.unmapped !== undefined ? { unmapped: config.unmapped } : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    ...(flows ? { flows } : {}),
  };
}

/** Where a setting's value came from. */
export type Origin = "default" | "config" | "option";

/** Everything that decides what the check checks, and how strictly. */
export interface Settings {
  /** The config file the settings are recorded under: the one read, or where the default one would be. */
  configFile: string;
  strictness: { value: string; from: Origin };
  unmapped: { value: string; from: Origin };
  tools: { value: string; from: Origin };
  flows: readonly FlowRule[];
  adapters: readonly { file: string; from: "config" | "option" }[];
  /** The files checked: a TypeScript project's (given with --project, or found), or those under paths. */
  scope: { project: string; found: boolean } | { paths: readonly string[]; given: boolean };
}

/**
 * The lock entries for these settings: one for the settings, and one for the TypeScript project's
 * file selection. `imported` are the files the check also read because the selected ones import them.
 */
export function settingsEntries(settings: Settings, root: string, imported: readonly string[] = []): FunctionReport[] {
  const name = path.basename(settings.configFile);
  const text = readIfFile(settings.configFile);
  const entry = new Entry(settings.configFile, name);
  const lineOf = (key: string) => lineOfKey(text, key);

  const scope = settings.scope;
  if ("project" in scope) entry.add(`permlang.project(${relative(root, scope.project)})`, scope.found ? "found" : "--project", 1);
  else for (const p of [...new Set(scope.paths.map((p) => relative(root, p)))].sort()) entry.add(`permlang.files(${p})`, scope.given ? "paths" : "default", 1);
  for (const file of imported) entry.add(`permlang.imported(${relative(root, file)})`, "imported", 1);

  for (const key of ["strictness", "unmapped", "tools"] as const) {
    const { value, from } = settings[key];
    entry.add(`permlang.${key}(${value})`, from === "option" ? `--${key}` : from === "config" ? name : "default", from === "config" ? lineOf(key) : 1);
  }
  for (const rule of settings.flows) entry.add(`permlang.flow(${formatFlow(rule)})`, name, lineOf("flows"));
  for (const a of settings.adapters) {
    entry.add(`permlang.adapter(${relative(root, a.file)} sha256:${contentHash(a.file)})`, a.from === "option" ? "--adapter" : name, a.from === "config" ? lineOf("adapters") : 1);
  }
  return "project" in scope ? [entry.report(), tsconfigEntry(scope.project)] : [entry.report()];
}

// --- tsconfig.json -----------------------------------------------------------------

/**
 * Reads a TypeScript project's config, following "extends".
 * @throws SettingsError when it's missing, malformed, extends a file that can't be read, lists
 *   a file in "files" that isn't there, or selects no files at all (each of which would
 *   silently change the files checked, or leave none to fail on).
 */
export function readTsConfig(file: string): ts.ParsedCommandLine {
  if (!existsSync(file)) throw new SettingsError(`${file} doesn't exist.`);
  if (!statSync(file).isFile()) throw new SettingsError(`${file} isn't a file.`);
  // Absolute, with `/`: ts.sys keeps the working directory it first saw, and TypeScript
  // compares paths in its own form.
  const absolute = path.resolve(file).replaceAll("\\", "/");
  const json = ts.parseJsonText(absolute, readFileSync(file, "utf8"));
  const parsed = ts.parseJsonSourceFileConfigFileContent(json, ts.sys, path.posix.dirname(absolute), undefined, absolute);
  // Syntax errors, and an "extends" that can't be read (code 5083); others, such as an
  // unknown compiler option, don't change which files are read.
  const problem = ts.getConfigFileParsingDiagnostics(parsed).find((d) => d.code < 2000 || d.code === 5083);
  if (problem) throw new SettingsError(`${file}: ${printable(ts.flattenDiagnosticMessageText(problem.messageText, " "))}`);
  // TypeScript reports these when it builds the program (TS6053, and TS18002 or TS18003 above),
  // and builds nothing; the check would pass on what's left.
  const missing = parsed.fileNames.find((f) => !ts.sys.fileExists(f));
  if (missing !== undefined) throw new SettingsError(`${file}: "files" lists ${printable(relative(process.cwd(), missing))}, which doesn't exist.`);
  if (parsed.fileNames.length === 0) throw new SettingsError(`${file} selects no files: nothing matches its "include" or "files".`);
  return parsed;
}

/**
 * Which files a tsconfig.json selects, and the compiler options that decide what imports and
 * globals resolve to. Narrowing "include" hides code; mapping `paths` or emptying `types` can
 * make an import or a global resolve to nothing, which PermLang can't see into.
 */
function tsconfigEntry(file: string): FunctionReport {
  const parsed = readTsConfig(file);
  const dir = path.dirname(path.resolve(file));
  const name = path.basename(file);
  const text = readIfFile(file);
  const entry = new Entry(file, name);
  // After "extends", TypeScript rewrites the inherited lists relative to this file.
  const raw = parsed.raw as { include?: unknown; exclude?: unknown; files?: unknown };
  const pattern = (p: string) => path.posix.normalize(p.replaceAll("\\", "/")).replace(/(.)\/$/, "$1");
  const list = (key: "include" | "exclude" | "files") => {
    const value = raw[key];
    if (!Array.isArray(value)) return false;
    if (value.length === 0) entry.add(`tsconfig.${key}(none)`, name, lineOfKey(text, key));
    for (const p of value) entry.add(`tsconfig.${key}(${pattern(String(p))})`, name, lineOfKey(text, key));
    return true;
  };
  const include = list("include");
  const files = list("files");
  if (!include && !files) entry.add("tsconfig.include(**/*)", "default", 1);
  // Without "exclude", the output folders are excluded.
  if (!list("exclude")) {
    for (const out of [parsed.options.outDir, parsed.options.declarationDir]) if (out) entry.add(`tsconfig.exclude(${relative(dir, out)})`, "default", 1);
  }

  const o = parsed.options;
  const option = (key: string, value: string) => entry.add(`tsconfig.${key}(${value})`, name, lineOfKey(text, key));
  if (o.baseUrl) option("baseUrl", relative(dir, o.baseUrl));
  // `paths` are relative to baseUrl, or else to the config that sets them (TypeScript records which).
  const pathsBase = o.baseUrl ?? (o as { pathsBasePath: string }).pathsBasePath;
  for (const [from, to] of Object.entries(o.paths ?? {})) option("paths", `${from} -> ${to.map((t) => relative(dir, path.resolve(pathsBase, t))).join(", ")}`);
  for (const d of o.rootDirs ?? []) option("rootDirs", relative(dir, d));
  for (const d of o.typeRoots ?? []) option("typeRoots", relative(dir, d));
  if (o.types) for (const t of o.types.length > 0 ? o.types : ["none"]) option("types", t);
  for (const l of o.lib ?? []) option("lib", l.replace(/^lib\./, "").replace(/\.d\.ts$/, ""));
  for (const c of o.customConditions ?? []) option("customConditions", c);
  for (const s of o.moduleSuffixes ?? []) option("moduleSuffixes", s === "" ? "none" : s);
  // The value TypeScript uses, set or worked out from the others: `module` decides
  // `moduleResolution`, and both decide whether a default import of a CommonJS module is the
  // module or nothing.
  for (const key of COMPUTED) {
    const shown = optionValue(key, computedOption(o, key));
    if (o[key] !== undefined) option(key, shown);
    else entry.add(`tsconfig.${key}(${shown})`, "default", 1);
  }
  // Off unless set. noResolve isn't among them: the check resolves imports regardless (load.ts).
  if (o.noLib) option("noLib", "true");
  // allowJs, or checkJs, which turns it on.
  if (computedOption(o, "allowJs")) option("allowJs", "true");
  // A workspace package linked into node_modules stays a package there, which isn't analyzed.
  if (o.preserveSymlinks) option("preserveSymlinks", "true");
  // An import of any file (`./x.css`) can resolve to a declaration file for it (`x.d.css.ts`).
  if (o.allowArbitraryExtensions) option("allowArbitraryExtensions", "true");
  // Packages named @typescript/lib-* replace the built-in declarations of globals (fetch, ...).
  if (o.libReplacement !== undefined) option("libReplacement", String(o.libReplacement));
  // Compiled code imports its helpers from tslib.
  if (o.importHelpers) option("importHelpers", "true");
  // What every JSX element calls.
  if (o.jsx !== undefined) option("jsx", JSX[o.jsx]);
  for (const key of ["jsxFactory", "jsxFragmentFactory", "jsxImportSource", "reactNamespace"] as const) if (o[key]) option(key, o[key]);
  return entry.report();
}

/** Options whose value TypeScript works out from the others when they aren't set: always recorded. */
const COMPUTED = [
  "target",
  "module",
  "moduleResolution",
  "moduleDetection",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "resolvePackageJsonExports",
  "resolvePackageJsonImports",
  "useDefineForClassFields",
] as const;

/**
 * An option's value as TypeScript works it out: as set, or from the options it depends on.
 * TypeScript keeps these rules in `computedOptions`, which isn't in its public types; a missing
 * rule throws (exit code 2), and the tests cover each one used.
 */
function computedOption(options: ts.CompilerOptions, key: (typeof COMPUTED)[number] | "allowJs"): unknown {
  const rules = (ts as unknown as { computedOptions: Record<string, { computeValue(o: ts.CompilerOptions): unknown }> }).computedOptions;
  return rules[key]!.computeValue(options);
}

/** An option's value as a word: an enum's name (`ESNext`, `Bundler`), or `true`/`false`. */
function optionValue(key: (typeof COMPUTED)[number], value: unknown): string {
  const names = ENUM_NAMES[key];
  // The options named there are numbers; the others are true or false.
  return names ? names[value as number]! : String(value);
}

/** The names of the values of the options in COMPUTED that are enums, from TypeScript's own enums. */
const ENUM_NAMES: Partial<Record<(typeof COMPUTED)[number], Record<number, string>>> = {
  // ESNext and Latest are the same target; the enum's own reverse lookup gives the latter.
  target: { ...ts.ScriptTarget, [ts.ScriptTarget.ESNext]: "ESNext" },
  module: ts.ModuleKind,
  moduleResolution: ts.ModuleResolutionKind,
  moduleDetection: ts.ModuleDetectionKind,
};

/**
 * "jsx" as tsconfig.json spells it. Every value is listed (tsconfig.json can't set None), so a
 * TypeScript release that adds one fails PermLang's own typecheck until it's added here.
 */
const JSX: Record<ts.JsxEmit, string> = {
  [ts.JsxEmit.None]: "none",
  [ts.JsxEmit.Preserve]: "preserve",
  [ts.JsxEmit.React]: "react",
  [ts.JsxEmit.ReactNative]: "react-native",
  [ts.JsxEmit.ReactJSX]: "react-jsx",
  [ts.JsxEmit.ReactJSXDev]: "react-jsxdev",
};

// --- reading settings back from a lock --------------------------------------------

/** Whether a configuration entry's capability is a setting (rather than a workflow's or a script's). */
export function isSetting(capability: string): boolean {
  return /^(?:permlang|tsconfig)\.\w+\(/.test(capability);
}

/** The scope a lock was written for: its `permlang.project(...)` and `permlang.files(...)` capabilities, sorted. */
export function scopeOf(lock: LockFile): string[] {
  const caps = Object.values(lock.functions).flat().filter((c) => /^permlang\.(?:project|files)\(/.test(c));
  return [...new Set(caps)].sort();
}

/** A scope as the command line would give it: `--project tsconfig.json`, or the paths. */
export function describeScope(scope: readonly string[]): string {
  if (scope.length === 0) return "files it doesn't record";
  return scope.map((c) => (c.startsWith("permlang.project(") ? `--project ${value(c)}` : value(c))).join(" ");
}

/** The setting a capability sets, for pairing an old value with a new one: "strictness", "tsconfig.include". */
export function settingKind(capability: string): string {
  return capability.slice(0, capability.indexOf("(")).replace(/^permlang\./, "");
}

/** Settings that hold one value, so a change is one old value and one new one. */
export function isSingleValued(capability: string): boolean {
  const kind = settingKind(capability);
  if (kind.startsWith("tsconfig.")) return !LISTS.has(kind.slice("tsconfig.".length));
  return ["strictness", "unmapped", "tools"].includes(kind);
}

/** tsconfig.json's settings that are lists, recorded a value at a time. */
const LISTS = new Set(["include", "exclude", "files", "paths", "rootDirs", "typeRoots", "types", "lib", "customConditions", "moduleSuffixes"]);

/**
 * A setting as a phrase: "strictness sketch", "unmapped: trust", "the adapter x.json (sha256:…)",
 * "exclude src/hidden.ts" (for tsconfig.json, after its file name).
 */
export function settingPhrase(capability: string): string {
  const kind = settingKind(capability);
  const v = value(capability);
  if (kind === "strictness") return `strictness ${v}`;
  if (kind === "unmapped" || kind === "tools") return `${kind}: ${v}`;
  if (kind === "flow") return `the flow rule ${v}`;
  if (kind === "adapter") return `the adapter ${v.replace(/ (sha256:\w+)$/, " ($1)")}`;
  if (kind === "project") return `the files of ${v}`;
  if (kind === "files") return `the files under ${v}`;
  if (kind === "imported") return `${v} (imported by the checked files)`;
  return `${kind.replace(/^tsconfig\./, "")} ${v}`;
}

/** The value a setting capability records: `permlang.unmapped(trust)` → `trust`. */
export function value(capability: string): string {
  return capability.slice(capability.indexOf("(") + 1, capability.endsWith(")") ? -1 : undefined);
}

// --- helpers -------------------------------------------------------------------------

/** One configuration entry, built a setting at a time; `via` records where each came from. */
class Entry {
  private readonly caps = new Map<string, { from: string; line: number }>();
  constructor(
    private readonly file: string,
    private readonly name: string,
  ) {}

  add(capability: string, from: string, line: number) {
    if (!this.caps.has(capability)) this.caps.set(capability, { from, line });
  }

  report(): FunctionReport {
    const actual = [...this.caps.keys()].sort();
    return {
      file: path.resolve(this.file),
      name: `<${this.name}>`,
      line: 1,
      annotated: false,
      declared: [],
      actual,
      via: Object.fromEntries(actual.map((c) => [c, [this.caps.get(c)!.from]])),
      sites: Object.fromEntries(actual.map((c) => [c, { line: this.caps.get(c)!.line, column: 1 }])),
      kind: "config",
    };
  }
}

function formatFlow(rule: FlowRule): string {
  return `${formatCapability(rule.from)} -> ${rule.to.map(formatCapability).join(", ")}`;
}

/**
 * The first 16 hex digits of a file's SHA-256. JSON is hashed as parsed, so line endings and
 * formatting (a Windows checkout's CRLF) don't change it; only content does.
 */
function contentHash(file: string): string {
  const text = readIfFile(file).replace(/^\u{FEFF}/u, "");
  let canonical: string;
  try {
    canonical = JSON.stringify(JSON.parse(text));
  } catch {
    canonical = text.replace(/\r\n/g, "\n");
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function readIfFile(file: string): string {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : "";
}

/** The line where `"key"` first appears in a JSON file, or 1. */
function lineOfKey(text: string, key: string): number {
  const at = text.indexOf(`"${key}"`);
  return at === -1 ? 1 : text.slice(0, at).split("\n").length;
}

function relative(root: string, file: string): string {
  return path.relative(root, path.resolve(file)).replaceAll("\\", "/") || ".";
}
