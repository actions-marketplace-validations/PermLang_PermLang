// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// New dependencies in the permission diff: a package added in a pull request can do
// anything, so the comment lists it, what PermLang knows about it, and its install scripts.

import { describe, expect, it } from "vitest";
import { AdapterIndex, loadAdapters } from "../src/adapters.js";
import { addedDependencies, overriddenDependencies, type PackageJson } from "../src/deps.js";

const adapters = new AdapterIndex(loadAdapters([]).adapters);
const installed: Record<string, PackageJson> = {
  "sketchy-telemetry": { scripts: { postinstall: "node collect.js", test: "vitest" } },
  zod: {},
};
const read = (name: string) => installed[name];

describe("new dependencies", () => {
  const base: PackageJson = { dependencies: { zod: "^3.0.0" }, devDependencies: { typescript: "^5.0.0" } };
  const head: PackageJson = {
    dependencies: { zod: "^3.0.0", stripe: "^22.0.0", "sketchy-telemetry": "1.0.0", pg: "^8.0.0" },
    devDependencies: { typescript: "^5.0.0", "date-fns": "^4.0.0", "not-installed": "^1.0.0" },
  };
  const added = addedDependencies(base, head, adapters, read);

  it("lists only packages the base didn't have, dependencies first", () => {
    expect(added.map((d) => `${d.name}${d.dev ? " (dev)" : ""}`)).toEqual(["pg", "sketchy-telemetry", "stripe", "date-fns (dev)", "not-installed (dev)"]);
  });

  it("says what PermLang knows about each one", () => {
    const known = Object.fromEntries(added.map((d) => [d.name, d.known]));
    expect(known).toEqual({ pg: "detected", "sketchy-telemetry": "unknown", stripe: "adapter", "date-fns": "pure", "not-installed": "unknown" });
  });

  it("lists install scripts when the package is installed, and says when it isn't", () => {
    const scripts = Object.fromEntries(added.map((d) => [d.name, d.installScripts]));
    expect(scripts["sketchy-telemetry"]).toEqual(["postinstall: node collect.js"]);
    expect(scripts["not-installed"]).toBeUndefined();
    expect(added.find((d) => d.name === "stripe")!.installed).toBe(false);
  });

  it("reports nothing without a base package.json, or when nothing was added", () => {
    expect(addedDependencies(undefined, head, adapters, read)).toEqual([]);
    expect(addedDependencies(head, head, adapters, read)).toEqual([]);
  });

  it("counts a package moved from devDependencies to dependencies as not new", () => {
    expect(addedDependencies({ devDependencies: { zod: "^3.0.0" } }, { dependencies: { zod: "^3.0.0" } }, adapters, read)).toEqual([]);
  });
});

// Found in the code review (G8): npm installs optional and peer dependencies too, and a package
// switched to another source keeps its name, and so its adapter, while its code changes.
describe("dependencies in every section, and from other sources", () => {
  const base: PackageJson = { dependencies: { lodash: "^4.17.21", zod: "^3.0.0", local: "file:../local" } };

  it("lists new optional and peer dependencies", () => {
    const added = addedDependencies(base, { ...base, optionalDependencies: { "sketchy-telemetry": "1.0.0" }, peerDependencies: { react: "^19.0.0" } }, adapters, read);
    expect(added.map((d) => `${d.name} ${d.section} ${d.change}`)).toEqual(["sketchy-telemetry optionalDependencies added", "react peerDependencies added"]);
    expect(added[0]!.installScripts).toEqual(["postinstall: node collect.js"]);
  });

  it.each([
    ["an npm alias", "npm:evil-lodash@1.0.0"],
    ["a git URL", "git+https://github.com/evil/lodash.git"],
    ["a GitHub shorthand", "evil/lodash#main"],
    ["a tarball URL", "https://evil.example/lodash.tgz"],
    ["a local folder", "file:../lodash"],
    ["a local tarball", "./vendor/lodash-4.17.21.tgz"],
  ])("reports an existing dependency switched to %s", (_, version) => {
    const changes = addedDependencies(base, { dependencies: { ...base.dependencies as object, lodash: version } }, adapters, read);
    expect(changes).toEqual([expect.objectContaining({ name: "lodash", version, previous: "^4.17.21", change: "source", section: "dependencies" })]);
  });

  it("doesn't report a version bump from the registry, or a local source that didn't change", () => {
    expect(addedDependencies(base, { dependencies: { ...base.dependencies as object, lodash: "^4.18.0", zod: "latest" } }, adapters, read)).toEqual([]);
    expect(addedDependencies(base, base, adapters, read)).toEqual([]);
  });

  it("reports a source that changed to another", () => {
    expect(addedDependencies(base, { dependencies: { ...base.dependencies as object, local: "file:../elsewhere" } }, adapters, read)).toEqual([
      expect.objectContaining({ name: "local", previous: "file:../local", version: "file:../elsewhere", change: "source" }),
    ]);
  });

  // A pull request's package.json can have anything in it; a number crashed the diff (O2).
  it("shows a version that isn't a string as written, and ignores sections that aren't objects", () => {
    const odd = { dependencies: { zod: "^3.0.0", weird: 1, nested: { a: 1 } }, devDependencies: "nope", optionalDependencies: ["x"] } as unknown as PackageJson;
    expect(addedDependencies({ dependencies: { zod: "^3.0.0" } }, odd, adapters, read).map((d) => `${d.name} ${d.version}`)).toEqual(["nested {\"a\":1}", "weird 1"]);
  });
});

describe("a package in more than one section", () => {
  it("counts a package the base lists twice once, and lists a new one the change lists twice once", () => {
    const base: PackageJson = { devDependencies: { react: "^19.0.0" }, peerDependencies: { react: "^19.0.0" } };
    const head: PackageJson = { ...base, dependencies: { zod: "^3.0.0" }, devDependencies: { react: "^19.0.0", zod: "^3.0.0" } };
    expect(addedDependencies(base, head, adapters, read).map((d) => `${d.name} ${d.section}`)).toEqual(["zod dependencies"]);
    expect(addedDependencies(base, base, adapters, read)).toEqual([]);
  });
});

// Found in the gate re-verification: overrides replace a package's code wherever it's installed,
// as a source change does, without touching its dependency entry.
describe("overrides and resolutions", () => {
  const base: PackageJson = { dependencies: { lodash: "^4.17.21" } };
  const evil = "npm:evil-lodash@1.0.0";

  it("reports an override, a yarn resolution, and a pnpm override that install another package", () => {
    const head = { ...base, overrides: { lodash: evil }, resolutions: { "**/lodash": evil }, pnpm: { overrides: { "foo>lodash@<5": evil } } } as PackageJson;
    expect(overriddenDependencies(base, head, adapters, read).map((d) => `${d.section}: ${d.name} -> ${d.version} (${d.change}, ${d.target})`)).toEqual([
      `overrides: lodash -> ${evil} (override, lodash)`,
      `resolutions: **/lodash -> ${evil} (override, lodash)`,
      `pnpm.overrides: foo>lodash@<5 -> ${evil} (override, lodash)`,
    ]);
  });

  it("reads npm's nested overrides, and `.` for the package itself", () => {
    const head = { ...base, overrides: { foo: { ".": "2.0.0", "@scope/bar@^1": { lodash: evil } } } } as PackageJson;
    expect(overriddenDependencies(base, head, adapters, read).map((d) => `${d.name} -> ${d.version} (${d.target})`)).toEqual([
      "foo -> 2.0.0 (foo)",
      `foo > @scope/bar@^1 > lodash -> ${evil} (lodash)`,
    ]);
  });

  it("reports one that changed, with what it was, and not one that didn't change or was removed", () => {
    const was = { ...base, overrides: { lodash: "4.17.20", zod: "3.0.0" }, resolutions: { "@scope/pkg": "1.0.0" } } as PackageJson;
    const now = { ...base, overrides: { lodash: evil }, resolutions: { "@scope/pkg": "1.0.0" } } as PackageJson;
    expect(overriddenDependencies(was, now, adapters, read)).toEqual([
      expect.objectContaining({ name: "lodash", version: evil, previous: "4.17.20", section: "overrides", change: "override", known: "adapter" }),
    ]);
    expect(overriddenDependencies(now, now, adapters, read)).toEqual([]);
    expect(overriddenDependencies(undefined, now, adapters, read)).toEqual([]);
  });

  it("names the package a pattern overrides, scoped or not, and lists its install scripts", () => {
    const head = { ...base, resolutions: { "parent/@scope/child@1": "2.0.0", "**/sketchy-telemetry": "1.0.0" } } as PackageJson;
    const changes = overriddenDependencies(base, head, adapters, read);
    expect(changes.map((d) => d.target)).toEqual(["@scope/child", "sketchy-telemetry"]);
    expect(changes[1]!.installScripts).toEqual(["postinstall: node collect.js"]);
  });

  it("shows a value that isn't a string as written, and ignores fields that aren't objects", () => {
    const head = { ...base, overrides: { lodash: 1 }, resolutions: "nope", pnpm: { overrides: ["x"] } } as unknown as PackageJson;
    expect(overriddenDependencies(base, head, adapters, read).map((d) => `${d.name} ${d.version}`)).toEqual(["lodash 1"]);
  });
});
