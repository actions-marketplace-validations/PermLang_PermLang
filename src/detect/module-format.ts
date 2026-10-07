// The module format TypeScript compiles a file to: whether its imports become require() calls,
// and its exports a plain object that other files can write to.

import { ts, type SourceFile } from "ts-morph";

// TypeScript's module kinds that emit ES modules: imports stay imports.
const ES_MODULE_KINDS = new Set([ts.ModuleKind.ES2015, ts.ModuleKind.ES2020, ts.ModuleKind.ES2022, ts.ModuleKind.ESNext, ts.ModuleKind.Preserve]);
const commonJs = new WeakMap<SourceFile, boolean>();

/**
 * Whether TypeScript compiles a file's imports into require() calls: "module" is CommonJS
 * (or AMD, UMD, or unset with an old target), or the file is Node's CommonJS: a .cts file,
 * or, under Node16 and later, one in a package that isn't `"type": "module"`.
 */
export function emitsCommonJs(file: SourceFile): boolean {
  let known = commonJs.get(file);
  if (known === undefined) {
    const project = file.getProject();
    const options = project.getCompilerOptions();
    const name = file.getFilePath();
    const kind = moduleKind(options);
    if (/\.c[jt]s$/.test(name)) known = true;
    else if (/\.m[jt]s$/.test(name)) known = false;
    else if (isNodeModuleKind(kind)) known = ts.getImpliedNodeFormatForFile(name, undefined, project.getModuleResolutionHost(), options) !== ts.ModuleKind.ESNext;
    else known = !ES_MODULE_KINDS.has(kind);
    commonJs.set(file, known);
  }
  return known;
}

/** Whether TypeScript compiles `import(x)` in this file into require(x). Node16 and later keep it, even in CommonJS. */
export function importCallsUseRequire(file: SourceFile): boolean {
  const kind = moduleKind(file.getProject().getCompilerOptions());
  return emitsCommonJs(file) && !isNodeModuleKind(kind) && kind !== ts.ModuleKind.Preserve;
}

/** "module" as TypeScript defaults it: CommonJS, unless the target is ES2015 or later. */
function moduleKind(options: ts.CompilerOptions): ts.ModuleKind {
  if (options.module !== undefined) return options.module;
  return (options.target ?? ts.ScriptTarget.ES5) >= ts.ScriptTarget.ES2015 ? ts.ModuleKind.ES2015 : ts.ModuleKind.CommonJS;
}

function isNodeModuleKind(kind: ts.ModuleKind): boolean {
  return kind >= ts.ModuleKind.Node16 && kind <= ts.ModuleKind.NodeNext;
}
