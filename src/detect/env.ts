// Environment variables: any expression typed NodeJS.ProcessEnv, and Vite-style
// `import.meta.env` (typed ImportMetaEnv).
//
// Matching the type rather than the text `process.env` means aliases
// (`const env = process.env; env.KEY`) and `import { env } from "node:process"`
// are covered. Any use that can't be tied to one name needs bare `env`.
//
// Without types, the text still counts: `process.env` when `process` is the global
// (Node's types missing, or a project's own `declare const process`), and
// `import.meta.env` when nothing declares it.

import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString, unwrapExpression, type CapabilityUse } from "./shared.js";
import { forEachDescendant } from "../walk.js";

export interface EnvUse {
  node: Node;
  uses: CapabilityUse[];
}

export function envUses(sourceFile: SourceFile): EnvUse[] {
  const out: EnvUse[] = [];
  forEachDescendant(sourceFile, (n) => {
    if (!Node.isIdentifier(n) && !Node.isPropertyAccessExpression(n) && !Node.isElementAccessExpression(n)) return;
    if (isNameNode(n)) return;
    const typed = envType(n);
    const kind = typed ?? untypedEnv(n);
    if (!kind || n.getFirstAncestor((a) => Node.isTypeNode(a))) return;
    const found = classify(n, kind, typed !== undefined);
    if (found) out.push(found);
  });
  return out;
}

const named = (name: string): Capability => ({ name: "env", arg: name });
const dynamic: Capability = { name: "env", dynamic: true };

// What Vite itself sets in import.meta.env, from the build rather than the environment.
const VITE_BUILT_INS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

type Environment = "process" | "import.meta";

/** `typed`: the environment is recognized by its type, so aliases of it are found by theirs. */
function classify(env: Node, kind: Environment, typed: boolean): EnvUse | undefined {
  const parent = env.getParentOrThrow();
  const use = (node: Node, capabilities: Capability[]): EnvUse => ({
    node,
    uses: capabilities.map((capability) => ({ capability, call: shorten(node.getText()), verb: "reads" })),
  });
  const variable = (name: string): Capability[] => (kind === "import.meta" && VITE_BUILT_INS.has(name) ? [] : [named(name)]);

  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === env) {
    const capabilities = variable(parent.getName());
    return capabilities.length > 0 ? use(parent, capabilities) : undefined;
  }
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === env) {
    const key = literalString(parent.getArgumentExpression());
    const capabilities = key === undefined ? [dynamic] : variable(key);
    return capabilities.length > 0 ? use(parent, capabilities) : undefined;
  }
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === env) {
    const binding = parent.getNameNode();
    // `const env = process.env` is an alias; its uses are found through their type. Without one,
    // they can't be, so the alias itself reads every variable.
    if (Node.isIdentifier(binding)) return typed ? undefined : use(parent, [dynamic]);
    if (Node.isObjectBindingPattern(binding)) {
      const caps = binding.getElements().flatMap((el) => {
        if (el.getDotDotDotToken()) return [dynamic];
        const prop = el.getPropertyNameNode();
        if (prop && Node.isComputedPropertyName(prop)) return [dynamic];
        return variable(prop?.getText() ?? el.getName());
      });
      return caps.length > 0 ? use(parent, caps) : undefined;
    }
  }
  if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
    const key = literalString(parent.getLeft());
    if (parent.getRight() === env && key !== undefined) return use(parent, [named(key)]);
  }
  // Passed along, spread, enumerated: every variable is reachable.
  return use(parent, [dynamic]);
}

/** Typed as Node's ProcessEnv, or as ImportMetaEnv (vite/client, and the frameworks that copy it). */
function envType(node: Node): Environment | undefined {
  const type = node.getType();
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol?.getName() === "ImportMetaEnv") return "import.meta";
  const fromLib = symbol?.getName() === "ProcessEnv" && symbol.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile());
  return fromLib ? "process" : undefined;
}

/** `process.env` on the global `process` that has no Node types, or `import.meta.env` with no type at all. */
function untypedEnv(node: Node): Environment | undefined {
  if (!Node.isPropertyAccessExpression(node) || node.getName() !== "env") return undefined;
  // `(process as any).env` too: without types, the cast hides nothing more.
  const object = unwrapExpression(node.getExpression());
  if (object.getText() === "import.meta") return "import.meta";
  return Node.isIdentifier(object) && object.getText() === "process" && isGlobalWithoutNodeTypes(object) ? "process" : undefined;
}

/**
 * `process` that isn't a local name: unresolved (Node's types missing), or declared by the
 * project itself (`declare const process: { env: ... }`), which bundlers fill from the environment.
 */
function isGlobalWithoutNodeTypes(identifier: Node): boolean {
  const declarations = identifier.getSymbol()?.getDeclarations() ?? [];
  return declarations.every((d) => d.getSourceFile().isDeclarationFile() || (Node.isVariableDeclaration(d) && d.getVariableStatement()?.hasDeclareKeyword() === true));
}

/** The `env` in `process.env`, or a name being declared: not an expression of its own. */
function isNameNode(node: Node): boolean {
  const parent = node.getParent();
  if (!parent) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === node;
  return "getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === node;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 70 ? `${oneLine.slice(0, 67)}...` : oneLine;
}
