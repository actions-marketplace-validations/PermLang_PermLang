// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// New dependencies in a change. A package added to package.json can do anything its
// code does, and PermLang only sees inside it if an adapter describes it. So the
// permission diff lists each new package, what PermLang knows about it, and the
// install scripts that run when it's installed. It also lists a package already there
// that is now installed from somewhere other than the registry (an alias, a URL, git,
// or a local path): `"lodash": "npm:evil-lodash@1.0.0"` keeps the name, so imports and
// adapters still say lodash, while the code is another package's. Overrides do the same
// to every copy in the dependency tree without touching the dependency's own entry:
// npm's `overrides` (nested too), Yarn's (and pnpm's) `resolutions`, and `pnpm.overrides`.

import type { AdapterIndex } from "./adapters.js";
import { isDetectedPackage } from "./unmapped.js";

/** package.json as read from a commit: nothing in it is trusted to have the right types. */
export interface PackageJson {
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  scripts?: unknown;
  overrides?: unknown;
  resolutions?: unknown;
  pnpm?: unknown;
}

/** The package.json fields whose packages npm installs. */
export type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

/** The package.json fields that replace what's installed for a package, wherever it is in the tree. */
export type OverrideSection = "overrides" | "resolutions" | "pnpm.overrides";

export interface DependencyChange {
  /** The package; for an override, the entry as written (`lodash`, `**\/lodash`, `foo > lodash` for npm's nesting). */
  name: string;
  version: string;
  /** Where package.json lists it. */
  section: DependencySection | OverrideSection;
  /** Whether it's in devDependencies. */
  dev: boolean;
  /**
   * added: package.json didn't have it; source: it did, and now installs it from another source;
   * override: an override that's new, or now says something else.
   */
  change: "added" | "source" | "override";
  /** For an override, the package it replaces (`lodash`). */
  target?: string;
  /** For a source change, the version it had; for an override, its old value, if it had one. */
  previous?: string;
  /** adapter: its calls are mapped; pure: touches nothing tracked; detected: built-in detection; unknown: not checked. */
  known: "adapter" | "pure" | "detected" | "unknown";
  /** Whether it's installed here, so its install scripts could be read. */
  installed: boolean;
  /** `preinstall`, `install`, and `postinstall` scripts, as `name: command`; undefined when not installed. */
  installScripts?: string[];
}

const SECTIONS: readonly DependencySection[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/**
 * Packages in `head` that `base` doesn't have, in any section npm installs, and packages both
 * have that `head` now installs from another source.
 */
export function addedDependencies(
  base: PackageJson | undefined,
  head: PackageJson,
  adapters: AdapterIndex,
  readInstalled: (name: string) => PackageJson | undefined,
): DependencyChange[] {
  // Without a base package.json (a new project), everything would be "new": not useful.
  if (!base) return [];
  const before = new Map<string, string>();
  for (const section of SECTIONS) for (const [name, version] of dependencies(base, section)) if (!before.has(name)) before.set(name, version);
  const out: DependencyChange[] = [];
  for (const section of SECTIONS) {
    for (const [name, version] of dependencies(head, section).sort(([a], [b]) => a.localeCompare(b))) {
      if (out.some((d) => d.name === name)) continue;
      const previous = before.get(name);
      const change = previous === undefined ? "added" : isOtherSource(version) && version !== previous ? "source" : undefined;
      if (!change) continue;
      const pkg = readInstalled(name);
      const scripts = pkg ? installScripts(pkg) : undefined;
      out.push({
        name,
        version,
        section,
        dev: section === "devDependencies",
        change,
        ...(change === "source" ? { previous } : {}),
        known: knownAs(name, adapters),
        installed: pkg !== undefined,
        ...(scripts ? { installScripts: scripts } : {}),
      });
    }
  }
  return out;
}

/**
 * Overrides in `head` that `base` doesn't have, or has with another value: each replaces what's
 * installed for a package, wherever it is in the dependency tree. One that's removed puts back
 * what the dependencies ask for, and isn't listed.
 */
export function overriddenDependencies(
  base: PackageJson | undefined,
  head: PackageJson,
  adapters: AdapterIndex,
  readInstalled: (name: string) => PackageJson | undefined,
): DependencyChange[] {
  // Without a base package.json (a new project), everything would be "new", as above.
  if (!base) return [];
  const out: DependencyChange[] = [];
  for (const section of OVERRIDE_SECTIONS) {
    const before = new Map(overrides(base, section));
    for (const [name, version] of overrides(head, section)) {
      const previous = before.get(name);
      if (previous === version) continue;
      const target = overrideTarget(name);
      const pkg = readInstalled(target);
      const scripts = pkg ? installScripts(pkg) : undefined;
      out.push({
        name,
        version,
        section,
        dev: false,
        change: "override",
        target,
        ...(previous !== undefined ? { previous } : {}),
        known: knownAs(target, adapters),
        installed: pkg !== undefined,
        ...(scripts ? { installScripts: scripts } : {}),
      });
    }
  }
  return out;
}

const OVERRIDE_SECTIONS: readonly OverrideSection[] = ["overrides", "resolutions", "pnpm.overrides"];

/**
 * An override field's entries, as `[name, value]`. npm nests them: `{ "foo": { "lodash": "1" } }`
 * overrides lodash under foo (`foo > lodash`), and `"."` stands for foo itself.
 */
function overrides(pkg: PackageJson, section: OverrideSection): [string, string][] {
  const field = section === "pnpm.overrides" ? (isObject(pkg.pnpm) ? pkg.pnpm.overrides : undefined) : pkg[section];
  // `path` is the entry's name so far: the field's own keys start it.
  const flatten = (value: unknown, path: string): [string, string][] => {
    if (!isObject(value)) return [[path, typeof value === "string" ? value : JSON.stringify(value)]];
    return Object.entries(value).flatMap(([key, inner]) => flatten(inner, key === "." ? path : `${path} > ${key}`));
  };
  return isObject(field) ? Object.entries(field).flatMap(([key, value]) => flatten(value, key)) : [];
}

/**
 * The package an override's name replaces: the last one in npm's nesting (`foo > lodash`),
 * pnpm's (`foo>lodash`), or Yarn's path (`**\/lodash`, `parent/@scope/child`), without its
 * version range (`lodash@<5`).
 */
function overrideTarget(name: string): string {
  const parts = name.split(">").pop()!.trim().split("/");
  const last = parts.length > 1 && parts.at(-2)!.startsWith("@") ? parts.slice(-2).join("/") : parts.at(-1)!;
  // The first character can be a scope's `@`.
  return last.replace(/(.)@.*$/s, "$1");
}

/** What PermLang knows about a package. */
function knownAs(name: string, adapters: AdapterIndex): DependencyChange["known"] {
  return adapters.isPure(name) ? "pure" : adapters.hasPackage(name) ? "adapter" : isDetectedPackage(name) ? "detected" : "unknown";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A version that doesn't come from the npm registry: an alias (`npm:other@1`), a URL, git
 * (`git+https:`, `github:`, `user/repo`), or a local folder or tarball (`file:`, `../x`, `x.tgz`).
 */
export function isOtherSource(version: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(version) || version.includes("/") || /^[.~]/.test(version) || /\.(?:tgz|tar|tar\.gz)$/i.test(version);
}

/** A section's packages and versions. A version that isn't a string is shown as its JSON. */
function dependencies(pkg: PackageJson, section: DependencySection): [string, string][] {
  const deps = pkg[section];
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) return [];
  return Object.entries(deps as Record<string, unknown>).map(([name, v]) => [name, typeof v === "string" ? v : JSON.stringify(v)]);
}

function installScripts(pkg: PackageJson): string[] {
  const scripts = Object(pkg.scripts) as Record<string, unknown>;
  return INSTALL_SCRIPTS.filter((s) => Object.hasOwn(scripts, s) && scripts[s]).map((s) => `${s}: ${String(scripts[s])}`);
}
