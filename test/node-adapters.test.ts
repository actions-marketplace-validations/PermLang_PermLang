// The built-in adapters for Node's modules must name functions the way @types/node
// declares them. Found in the 0.3 review: process.kill and cluster.fork are interface
// members (Process.kill, Cluster.fork), so keys written as "kill" and "fork" never matched
// and those calls reported nothing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import { builtinAdapterPaths } from "../src/adapters.js";
import { containerName } from "../src/detect/shared.js";

const typesDir = fileURLToPath(new URL("../node_modules/@types/node/", import.meta.url));
const project = new Project({ skipAddingFilesFromTsConfig: true });
project.addSourceFilesAtPaths(path.join(typesDir, "**/*.d.ts").replaceAll("\\", "/"));

/** Every function key an adapter could use for `pkg`: `name`, `Container.name`, `Container.constructor`. */
function declaredKeys(pkg: string): Set<string> {
  const keys = new Set<string>();
  const add = (container: string | undefined, member: string) => keys.add(container ? `${container}.${member}` : member);
  const inPackage = (n: Node) =>
    n.getAncestors().some((a) => Node.isModuleDeclaration(a) && [pkg, `node:${pkg}`].includes(a.getName().replace(/^["']|["']$/g, "").replace(/\/.*/, "")));
  project.getSourceFiles().forEach((file: SourceFile) =>
    file.forEachDescendant((n) => {
      if (!inPackage(n)) return;
      if (Node.isFunctionDeclaration(n) || Node.isMethodSignature(n) || Node.isMethodDeclaration(n)) add(containerName(n), n.getName() ?? "");
      else if (Node.isConstructorDeclaration(n) || Node.isConstructSignatureDeclaration(n)) add(containerName(n), "constructor");
    }),
  );
  return keys;
}

const nodeAdapters = builtinAdapterPaths().filter((f) => path.basename(f).startsWith("node-"));

describe("built-in adapters for Node's modules", () => {
  it("are found", () => expect(nodeAdapters.length).toBeGreaterThan(5));

  for (const file of nodeAdapters) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as { package: string | string[]; functions?: Record<string, unknown> };
    const packages = typeof manifest.package === "string" ? [manifest.package] : manifest.package;
    it(`${path.basename(file)} names functions as @types/node declares them`, () => {
      const declared = new Set(packages.flatMap((p) => [...declaredKeys(p)]));
      const missing = Object.keys(manifest.functions ?? {}).filter((key) => !declared.has(key));
      expect(missing).toEqual([]);
    });
  }
});
