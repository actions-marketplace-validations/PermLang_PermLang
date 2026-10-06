// New dependencies in a change. A package added to package.json can do anything its
// code does, and PermLang only sees inside it if an adapter describes it. So the
// permission diff lists each new package, what PermLang knows about it, and the
// install scripts that run when it's installed. It also lists a package already there
// that is now installed from somewhere other than the registry (an alias, a URL, git,
// or a local path): `"lodash": "npm:evil-lodash@1.0.0"` keeps the name, so imports and
// adapters still say lodash, while the code is another package's.

import type { AdapterIndex } from "./adapters.js";
import { isDetectedPackage } from "./unmapped.js";

/** package.json as read from a commit: nothing in it is trusted to have the right types. */
export interface PackageJson {
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  scripts?: unknown;
}

/** The package.json fields whose packages npm installs. */
export type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";

export interface DependencyChange {
  name: string;
  version: string;
  /** Where package.json lists it. */
  section: DependencySection;
  /** Whether it's in devDependencies. */
  dev: boolean;
  /** added: package.json didn't have it; source: it did, and now installs it from another source. */
  change: "added" | "source";
  /** For a source change, the version it had. */
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
        known: adapters.isPure(name) ? "pure" : adapters.hasPackage(name) ? "adapter" : isDetectedPackage(name) ? "detected" : "unknown",
        installed: pkg !== undefined,
        ...(scripts ? { installScripts: scripts } : {}),
      });
    }
  }
  return out;
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
