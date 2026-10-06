// New dependencies in the permission diff: a package added in a pull request can do
// anything, so the comment lists it, what PermLang knows about it, and its install scripts.

import { describe, expect, it } from "vitest";
import { AdapterIndex, loadAdapters } from "../src/adapters.js";
import { addedDependencies, type PackageJson } from "../src/deps.js";

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
