// Loading a module by name at runtime. TypeScript types most loads, so calls on what
// they load resolve like any other call. These forms it can't see through:
//   - require(x) in TypeScript, and import(x) when x isn't written as a literal (a
//     const, an `as const` property, an enum member): the result is `any`;
//   - URL specifiers (data:, http:, https:, blob:, file:) in any import form: Node
//     runs code that isn't a file in the project.
// For an untyped load, what's loaded decides the outcome:
//   - a project file: its top-level code runs, and any of its exports can be called
//     (call-graph edges, see graph.ts);
//   - a package with no adapter: trusted, and listed like any call into it (PERM006);
//   - data (JSON, an asset; see loadsData), or a package declared pure: nothing;
//   - anything else is unverifiable: a module whose functions carry capabilities
//     (child_process, fs, a database client, a package an adapter maps), a URL, a
//     computed specifier, or a file outside the project (JavaScript behind a .d.ts).

import { isBuiltin } from "node:module";
import path from "node:path";
import { Node, SyntaxKind, ts, type CallExpression, type SourceFile } from "ts-morph";
import { packageName, type AdapterIndex } from "../adapters.js";
import { isRequire, requiresCapabilityModule } from "./functions.js";
import { emitsCommonJs, importCallsUseRequire } from "./module-format.js";
import { literalString, resolvedDeclaration, unwrapExpression, type CallLike } from "./shared.js";

export type LoadTarget =
  | { kind: "file"; file: SourceFile }
  | { kind: "package"; name: string }
  | { kind: "none" }
  | { kind: "unverifiable" };

export interface Load {
  call: CallExpression;
  /** The specifier's value, when it's known statically. */
  specifier: string | undefined;
  /** TypeScript gives the loaded module the type `any`, so nothing called on it resolves. */
  untyped: boolean;
  /** How the specifier is resolved: import() and require() use different package.json conditions. */
  mode: "import" | "require";
}

// Node's ESM loader runs these; none is a file TypeScript resolves or PermLang reads.
const URL_SCHEME = /^(data|https?|blob|file):/i;

export function isUrlSpecifier(specifier: string): boolean {
  return URL_SCHEME.test(specifier);
}

/** `require(x)` (also through createRequire, or with its types erased) or `import(x)`. */
export function loadOf(call: CallLike): Load | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const [argument] = call.getArguments();
  if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
    // TypeScript resolves import() only when its specifier is written as a literal.
    const written = argument !== undefined && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument));
    return { call, specifier: literalString(argument), untyped: !written, mode: "import" };
  }
  if (!isRequireCall(call)) return undefined;
  // In JavaScript files TypeScript types require() like an import; in TypeScript it's `any`.
  return { call, specifier: literalString(argument), untyped: call.getType().isAny(), mode: "require" };
}

function isRequireCall(call: CallExpression): boolean {
  const declaration = resolvedDeclaration(call);
  if (declaration) return isRequire(declaration);
  // `declare const require: any; require("x")` or `(require as any)("x")`: still require.
  const written = call.getExpression();
  const callee = unwrapExpression(written);
  return Node.isIdentifier(callee) && callee.getText() === "require" && (callee.getType().isAny() || callee !== written);
}

/** What an untyped load (or one with a URL specifier) loads. */
export function loadTarget(load: Load, adapters: AdapterIndex): LoadTarget {
  const { specifier, mode } = load;
  const from = load.call.getSourceFile();
  if (specifier === undefined || isUrlSpecifier(specifier)) return { kind: "unverifiable" };
  // Resolve first: a bare specifier can be a path alias (`@/lib/helper`) for a project file.
  const resolved = resolve(specifier, from, mode);
  const file = resolved && from.getProject().getSourceFile(resolved);
  if (file && !file.isDeclarationFile() && !file.getFilePath().split("/").includes("node_modules")) return { kind: "file", file };
  const viaRequire = mode === "require" || importCallsUseRequire(from);
  if (loadsData(specifier, from, viaRequire) || (!viaRequire && resolved?.endsWith(".json"))) return { kind: "none" };
  // A path that isn't a project file: JavaScript the checker doesn't analyze.
  if (isPath(specifier)) return { kind: "unverifiable" };

  const name = packageName(specifier);
  if (adapters.isPure(name)) return { kind: "none" };
  // A Node built-in no adapter declares pure (node:sqlite, v8, ...) may carry capabilities.
  if (requiresCapabilityModule(specifier, adapters) || isBuiltin(specifier)) return { kind: "unverifiable" };
  return { kind: "package", name };
}

function resolve(specifier: string, from: SourceFile, mode: "require" | "import", options: ts.CompilerOptions = {}): string | undefined {
  const project = from.getProject();
  const resolutionMode = mode === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
  const compilerOptions = { ...project.getCompilerOptions(), ...options };
  return ts.resolveModuleName(specifier, from.getFilePath(), compilerOptions, project.getModuleResolutionHost(), undefined, undefined, resolutionMode)
    .resolvedModule?.resolvedFileName;
}

// --- data and code -----------------------------------------------------------

/**
 * Whether loading `specifier` loads data rather than code. A bundler, or Node's ES module
 * loader, loads a stylesheet, an image, or JSON as what it is (Node won't load an unknown
 * extension at all). Node's require() runs any file but a .json one as JavaScript, and
 * adds `.js` to a path that doesn't exist: `require("./theme.css")` runs ./theme.css, or
 * ./theme.css.js. So through require(), only a .json file that exists is data.
 */
export function loadsData(specifier: string, from: SourceFile, viaRequire: boolean): boolean {
  if (!viaRequire) return isAsset(specifier);
  // Node picks the loader by the exact extension (`./data.JSON` runs as JavaScript), and
  // a query string is part of the file name.
  if (!specifier.endsWith(".json")) return false;
  if (isPath(specifier)) return from.getProject().getFileSystem().fileExistsSync(path.resolve(from.getDirectoryPath(), specifier));
  // A package's file: TypeScript finds it when it's told it may resolve JSON.
  return resolve(specifier, from, "require", { resolveJsonModule: true })?.endsWith(".json") === true;
}

/**
 * A path rather than a package name: relative, or absolute on any system (`/opt/x.js`,
 * `C:/x.js`), since where the code runs may not be where it's checked.
 */
function isPath(specifier: string): boolean {
  return specifier.startsWith(".") || path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier);
}

/**
 * Whether a module reference loads through require(): `import x = require()` always does,
 * and an `import`, `export ... from`, or `import()` does in a file TypeScript compiles to
 * CommonJS.
 */
export function referenceUsesRequire(reference: Node): boolean {
  if (Node.isImportEqualsDeclaration(reference)) return true;
  if (Node.isCallExpression(reference)) return importCallsUseRequire(reference.getSourceFile());
  return emitsCommonJs(reference.getSourceFile());
}

// Non-code imports that bundlers handle; TypeScript doesn't resolve them without declarations.
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|txt|wasm|html)$/i;

/**
 * A stylesheet, image, or other file a bundler loads, judged by the path alone (enough
 * only for an ES import; see loadsData): a query
 * or fragment (`./styles.css?inline`) doesn't change what's loaded, so `./evil.js?x=.css`
 * is still a script. A URL is never an asset: `data:text/javascript,...//.css` is code.
 */
export function isAsset(specifier: string): boolean {
  if (isUrlSpecifier(specifier)) return false;
  // `#` at the start is a package.json "imports" alias, not a fragment.
  const path = specifier.slice(0, 1) + specifier.slice(1).replace(/[?#].*$/s, "");
  return ASSET.test(path);
}
