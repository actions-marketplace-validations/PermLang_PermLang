// Adapter manifests: small JSON files that map a library's functions to
// capabilities. PermLang ships adapters for common libraries (adapters/*.json)
// and teams can add their own.
//
//   {
//     "permlang": 1,
//     "package": "stripe",                      // or ["http", "https"]
//     "defines": ["payments.refund"],          // app-level capability names
//     "default": ["net(api.stripe.com)"],       // any other method in the package
//     "functions": {
//       "RefundResource.create": ["payments.refund", "net(api.stripe.com)"],
//       "WebhookObject.constructEvent": []      // explicitly nothing
//     }
//   }
//
// A function key is `Container.member`, where the container is the class,
// interface, or type alias that declares it: `Container()` for a call signature,
// `Container.constructor` for a constructor, or just `name` for a top-level
// function. Arguments may use placeholders: `{host:N}` is the host named by
// argument N (a URL, or an options object with url/hostname/host), and `{arg:N}`
// is argument N as a literal string. Either is dynamic when it can't be known.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Node } from "ts-morph";
import { BUILTIN_VOCABULARY, CAPABILITY_NAME, UNVERIFIABLE, parsePermList, type Capability } from "./capability.js";
import { containerName, hostOf, literalString } from "./detect/shared.js";

interface Template {
  name: string;
  /** A literal scope, or a placeholder filled from the call's arguments. */
  arg?: string | { kind: "host" | "arg"; index: number; overridable?: boolean };
}

export interface Adapter {
  package: string;
  source: string;
  defines: string[];
  default?: Template[];
  functions: Map<string, Template[]>;
}

export interface ParsedManifest {
  packages: string[];
  defines: string[];
  default?: Template[];
  functions: Map<string, Template[]>;
}

export class AdapterError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid adapter manifest:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  }
}

const FIELDS = new Set(["$schema", "permlang", "package", "defines", "default", "functions"]);
const PLACEHOLDER = /^\{(host|arg):(\d+)(\+)?\}$/;
const TEMPLATE = /^([^()]+)(?:\((.*)\))?$/;

/** @perm fs.read */
export function builtinAdapterPaths(): string[] {
  const dir = fileURLToPath(new URL("../adapters", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Loads the built-in adapters plus `extra` (listed first, so a team's adapter wins).
 * @perm fs.read
 */
export function loadAdapters(extra: readonly string[]): { adapters: Adapter[]; errors: string[] } {
  const adapters: Adapter[] = [];
  const errors: string[] = [];
  for (const file of [...extra, ...builtinAdapterPaths()]) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    const { manifest, errors: manifestErrors } = parseManifest(raw, file);
    errors.push(...manifestErrors);
    if (!manifest) continue;
    for (const pkg of manifest.packages) {
      adapters.push({ package: pkg, source: file, defines: manifest.defines, default: manifest.default, functions: manifest.functions });
    }
  }
  return { adapters, errors };
}

export function parseManifest(raw: unknown, source: string): { manifest?: ParsedManifest; errors: string[] } {
  const errors: string[] = [];
  const fail = (message: string) => ({ errors: [...errors, `${source}: ${message}`] });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("a manifest must be a JSON object");
  const m = raw as Record<string, unknown>;

  for (const key of Object.keys(m)) if (!FIELDS.has(key)) errors.push(`${source}: unknown field "${key}"`);
  if (m.permlang !== 1) errors.push(`${source}: unsupported manifest version ${JSON.stringify(m.permlang)}; expected "permlang": 1`);

  const packages = typeof m.package === "string" ? [m.package] : m.package;
  if (!Array.isArray(packages) || packages.length === 0 || !packages.every((p) => typeof p === "string" && p !== "")) {
    errors.push(`${source}: "package" must be a package name or a non-empty list of them`);
  }

  const defines = m.defines ?? [];
  if (!Array.isArray(defines) || !defines.every((d) => typeof d === "string")) {
    errors.push(`${source}: "defines" must be a list of capability names`);
  }
  const defined = Array.isArray(defines) ? (defines as string[]) : [];
  for (const d of defined) {
    if (BUILTIN_VOCABULARY.has(d)) errors.push(`${source}: redefines built-in capability "${d}"`);
    else if (!CAPABILITY_NAME.test(d)) errors.push(`${source}: invalid capability name "${d}"`);
  }
  // Adapters may also mark a function as unverifiable (vm.runInNewContext, new Worker).
  const vocabulary = new Set([...BUILTIN_VOCABULARY, ...defined, UNVERIFIABLE]);

  const templates = (value: unknown, where: string): Template[] | undefined => {
    if (!Array.isArray(value)) {
      errors.push(`${source}: ${where} must be an array of capabilities`);
      return undefined;
    }
    return value.flatMap((entry) => {
      const t = typeof entry === "string" ? parseTemplate(entry, vocabulary) : { error: "must be a string" };
      if ("error" in t) {
        errors.push(`${source}: ${where}: ${JSON.stringify(entry)} ${t.error}`);
        return [];
      }
      return [t];
    });
  };

  const functions = new Map<string, Template[]>();
  if (m.functions !== undefined) {
    if (typeof m.functions !== "object" || m.functions === null || Array.isArray(m.functions)) {
      errors.push(`${source}: "functions" must be an object`);
    } else {
      for (const [key, value] of Object.entries(m.functions)) {
        const t = templates(value, `functions["${key}"]`);
        if (t) functions.set(key, t);
      }
    }
  }
  const fallback = m.default === undefined ? undefined : templates(m.default, `"default"`);

  if (errors.length > 0) return { errors };
  return {
    manifest: { packages: packages as string[], defines: defined, functions, ...(fallback ? { default: fallback } : {}) },
    errors,
  };
}

function parseTemplate(text: string, vocabulary: ReadonlySet<string>): Template | { error: string } {
  const match = TEMPLATE.exec(text.trim());
  if (!match) return { error: "is not a capability" };
  const [, name, arg] = match as unknown as [string, string, string | undefined];
  const placeholder = arg === undefined ? undefined : PLACEHOLDER.exec(arg.trim());
  if (arg !== undefined && arg.includes("{") && !placeholder) {
    return { error: "has an invalid placeholder; use {host:N}, {host:N+}, or {arg:N}" };
  }
  // Validate the rest with the same grammar as @perm, standing a value in for any placeholder.
  const { errors } = parsePermList(placeholder ? `${name}(x)` : text, vocabulary);
  if (errors.length > 0) return { error: errors[0]!.reason };
  if (placeholder) {
    const kind = placeholder[1] as "host" | "arg";
    if (placeholder[3] && kind !== "host") return { error: "can't use +: only {host:N+} can be overridden by later arguments" };
    return { name, arg: { kind, index: Number(placeholder[2]), ...(placeholder[3] ? { overridable: true } : {}) } };
  }
  return arg === undefined ? { name } : { name, arg: arg.trim() };
}

// --- matching ----------------------------------------------------------------

export class AdapterIndex {
  private readonly byPackage = new Map<string, Adapter[]>();
  readonly vocabulary: ReadonlySet<string>;

  hasPackage(name: string): boolean {
    return this.byPackage.has(packageName(name));
  }

  /** A package declared pure: every adapter for it maps everything to nothing (adapters/pure.json). */
  isPure(name: string): boolean {
    const adapters = this.byPackage.get(packageName(name));
    return adapters !== undefined && adapters.every((a) => (a.default ?? []).length === 0 && [...a.functions.values()].every((t) => t.length === 0));
  }

  constructor(adapters: readonly Adapter[]) {
    for (const a of adapters) this.byPackage.set(a.package, [...(this.byPackage.get(a.package) ?? []), a]);
    this.vocabulary = new Set([...BUILTIN_VOCABULARY, ...adapters.flatMap((a) => a.defines)]);
  }

  /** What calling `declaration` with `args` touches; pass no args for a function used as a value. */
  forDeclaration(declaration: Node, args: readonly Node[]): Capability[] {
    const pkg = packageOf(declaration);
    const adapters = pkg === undefined ? undefined : this.byPackage.get(pkg);
    if (!adapters) return [];

    const key = functionKey(declaration);
    const listed = key === undefined ? undefined : adapters.find((a) => a.functions.has(key))?.functions.get(key);
    const isConstructor = Node.isConstructorDeclaration(declaration) || Node.isConstructSignatureDeclaration(declaration);
    const templates = listed ?? (isConstructor ? undefined : adapters.find((a) => a.default)?.default);
    return (templates ?? []).map((t) => instantiate(t, args));
  }
}

function instantiate(t: Template, args: readonly Node[]): Capability {
  if (t.arg === undefined || typeof t.arg === "string") return t.arg === undefined ? { name: t.name } : { name: t.name, arg: t.arg };
  const arg = args[t.arg.index];
  let value = t.arg.kind === "host" ? hostOf(arg) : literalString(arg);
  // {host:N+}: a later options argument can replace the host, as in Node's
  // http.request(url, { hostname }). Options that might carry one make it unknown.
  if (t.arg.overridable) {
    for (const later of args.slice(t.arg.index + 1)) {
      const override = hostOverride(later);
      if (override !== null) value = override;
    }
  }
  return value === undefined ? { name: t.name, dynamic: true } : { name: t.name, arg: value };
}

/** The host an options argument sets: a string; undefined if it may set one that can't be known; null if it can't set one. */
function hostOverride(arg: Node): string | undefined | null {
  if (arg.getType().getCallSignatures().length > 0) return null; // a callback
  if (!Node.isObjectLiteralExpression(arg)) return arg.getType().isObject() ? undefined : null;
  if (arg.getProperties().some((p) => Node.isSpreadAssignment(p))) return undefined;
  const setsHost = arg.getProperties().some((p) => {
    const name = "getName" in p ? (p as { getName(): string }).getName() : undefined;
    return name === "hostname" || name === "host" || name === "url";
  });
  return setsHost ? hostOf(arg) : null;
}

/** The package a declaration belongs to: an ambient `declare module "x"`, else its node_modules folder. */
export function packageOf(declaration: Node): string | undefined {
  for (const a of declaration.getAncestors()) {
    if (!Node.isModuleDeclaration(a) || !Node.isStringLiteral(a.getNameNode())) continue;
    const name = a.getNameNode().getText().slice(1, -1);
    // `declare module "../index"` augments a file in the same package (lodash does this).
    if (!name.startsWith(".")) return packageName(name);
  }
  const parts = declaration.getSourceFile().getFilePath().split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i === -1) return undefined;
  const [first, second] = parts.slice(i + 1);
  if (first === "@types" && second) return second.includes("__") ? `@${second.replace("__", "/")}` : second;
  if (first?.startsWith("@") && second) return `${first}/${second}`;
  return first;
}

export function packageName(specifier: string): string {
  const bare = specifier.replace(/^node:/, "");
  const parts = bare.split("/");
  return bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function functionKey(d: Node): string | undefined {
  let member: string | undefined;
  let named: Node = d;
  if (Node.isCallSignatureDeclaration(d)) member = "()";
  else if (Node.isConstructorDeclaration(d) || Node.isConstructSignatureDeclaration(d)) member = "constructor";
  else {
    // A function-typed property or variable: the signature is its type; the name is on the holder.
    if (Node.isFunctionTypeNode(d) || Node.isArrowFunction(d) || Node.isFunctionExpression(d)) named = d.getParent() ?? d;
    member = "getName" in named ? (named as { getName(): string | undefined }).getName() : undefined;
    // Bundled .d.ts files rename clashing declarations: `tool$1`, exported as `tool`.
    member = member?.replace(/\$\d+$/, "");
  }
  if (!member) return undefined;
  const container = containerName(named);
  if (!container) return member === "()" ? undefined : member;
  return member === "()" ? `${container}()` : `${container}.${member}`;
}
