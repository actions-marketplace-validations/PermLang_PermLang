// Building the ts-morph Project to check. TypeScript's parser recurses once per level of
// nesting, so a file nested deeply enough (thousands of parentheses or brackets) makes it
// overflow the stack. Rather than crash, such a file is read as an empty module and
// reported as unverifiable (see check.ts); the rest of the project is checked as usual.
// It's emptied where it is, so files that import it get the empty one too.

import { statSync } from "node:fs";
import path from "node:path";
import { Project, ts, type FileSystemHost, type SourceFile } from "ts-morph";

const unparsed = new WeakMap<SourceFile, string>();

/** Why a file in the project couldn't be parsed, if it couldn't. */
export function unparsedReason(sourceFile: SourceFile): string | undefined {
  return unparsed.get(sourceFile);
}

/** What went wrong analyzing a file, for a message. */
export function failureReason(error: unknown): string {
  if (error instanceof RangeError && /call stack/i.test(error.message)) return "its code is nested too deeply";
  return error instanceof Error ? error.message : String(error);
}

/**
 * A project of these files (paths or glob patterns), with compiler options, and every file they
 * import, as a tsconfig.json's project has. Code a checked file imports runs with it, wherever it
 * is: left out, calls into it would reach nothing. (The check analyzes the project's own files
 * among them, not packages or declaration files.)
 * @perm fs.read
 */
export function projectOfFiles(files: readonly string[], compilerOptions: ts.CompilerOptions): Project {
  const blank = new Set<string>();
  const project = new Project({ compilerOptions, fileSystem: blanking(blank) });
  // A file that exists is added by its own path, a file at a time, which also finds the ones that
  // can't be parsed. Given to ts-morph together as glob patterns, files on more than one Windows
  // drive matched nothing, and went unchecked. Anything else (`src/**/*.ts`) is a pattern.
  for (const file of files) {
    if (isFile(file)) add(project, file, blank);
    else project.addSourceFilesAtPaths(file);
  }
  project.resolveSourceFileDependencies();
  return project;
}

/**
 * The project a tsconfig.json describes, and every file it imports. With "noResolve", TypeScript
 * leaves imported files out of its program, but they still run: the check resolves them anyway.
 * @perm fs.read
 */
export function projectOfTsConfig(tsConfigFilePath: string): Project {
  const blank = new Set<string>();
  const fileSystem = blanking(blank);
  const compilerOptions: ts.CompilerOptions = { noResolve: false };
  try {
    return new Project({ tsConfigFilePath, compilerOptions, fileSystem });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const project = new Project({ tsConfigFilePath, compilerOptions, fileSystem, skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  const parsed = ts.getParsedCommandLineOfConfigFile(tsConfigFilePath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  // (The tsconfig was read already, so it can be parsed.)
  for (const file of parsed!.fileNames) add(project, file, blank);
  project.resolveSourceFileDependencies();
  return project;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function add(project: Project, file: string, blank: Set<string>): void {
  try {
    project.addSourceFileAtPath(file);
  } catch (error) {
    blank.add(key(file));
    unparsed.set(project.addSourceFileAtPath(file), failureReason(error));
  }
}

// An empty module, so imports of it still resolve, and still run what it stands for.
const EMPTY = "export {};\n";

/** The real file system, except that the files in `blank` read as an empty module. (ts-morph reads source files synchronously.) */
function blanking(blank: ReadonlySet<string>): FileSystemHost {
  const real = new Project().getFileSystem();
  return new Proxy(real, {
    get(target, property) {
      if (property === "readFileSync") return (file: string, encoding?: string) => (blank.has(key(file)) ? EMPTY : target.readFileSync(file, encoding));
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function key(file: string): string {
  return path.resolve(file).replaceAll("\\", "/").toLowerCase();
}
