/**
 * Which lock files the PermLang Action's steps read, in a commit's workflows and in the working
 * tree. A change that points the Action at another lock file (`args: --lock other.json`, or
 * another `working-directory`) would otherwise leave the base commit's lock behind: the new one
 * approves whatever the change adds, and the check passes. `check --base` and `diff` use this to
 * say so.
 * @module
 * @perm fs.read, exec
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DEFAULT_LOCK, parseArgs, type Args } from "./args.js";
import { YamlFile, type Value } from "./yaml-nodes.js";

/** A workflow or Action file, or undefined when it doesn't exist. */
export type Reader = (file: string) => string | undefined;

/**
 * The lock files the base commit's workflows check with that this change no longer reads, when
 * this check (reading `lockFile`, or none with --no-lock) isn't one of the base's. Paths are
 * from the repository root. When no PermLang step in the base's workflows names its lock
 * plainly (none there, or one set by an expression), the base's lock is taken to be
 * permlang.lock.json in this folder.
 */
export function movedLocks(base: string, lockFile: string | undefined): string[] {
  const root = repositoryRoot();
  const cwd = realpathSync.native(process.cwd());
  const fromRoot = (file: string) => path.relative(root, path.resolve(cwd, file)).replaceAll("\\", "/");
  const atBase: Reader = (file) => gitText(root, "cat-file", "blob", `${base}:${file}`);
  const baseFiles = git(root, "ls-tree", "-z", "--name-only", base, "--", ".github/workflows/").split("\0").filter(isWorkflow);
  const read = locksRead(baseFiles, atBase);
  if (read.size === 0) read.add(fromRoot(DEFAULT_LOCK));
  if (lockFile !== undefined && read.has(fromRoot(lockFile))) return [];

  const dir = path.join(root, ".github", "workflows");
  const here: Reader = (file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8") : undefined);
  const headFiles = existsSync(dir) ? readdirSync(dir).map((f) => `.github/workflows/${f}`).filter(isWorkflow) : [];
  const stillRead = locksRead(headFiles, here);
  return [...read].filter((lock) => !stillRead.has(lock) && gitText(root, "cat-file", "-e", `${base}:${lock}`) !== undefined).sort();
}

/** A step that runs the PermLang Action, with its `working-directory` and `args` as written (undefined when not set). */
export interface PermLangStep {
  workingDirectory: string | undefined;
  args: string | undefined;
}

/** The steps in these workflows that run the PermLang Action. */
export function permLangSteps(files: readonly string[], read: Reader): PermLangStep[] {
  const found: PermLangStep[] = [];
  for (const file of files) {
    const yaml = parse(read(file));
    if (!yaml) continue;
    for (const jobs of yaml.get(yaml.root(), "jobs")) {
      for (const job of yaml.fields(jobs)) {
        for (const steps of yaml.get(job.value, "steps")) {
          for (const step of yaml.items(steps)) {
            const uses = scalar(yaml, yaml.get(step, "uses"));
            if (uses === undefined || !isPermLang(uses, read)) continue;
            const inputs = yaml.get(step, "with");
            const input = (name: string) => scalar(yaml, inputs.flatMap((w) => yaml.get(w, name)));
            found.push({ workingDirectory: input("working-directory"), args: input("args") });
          }
        }
      }
    }
  }
  return found;
}

/** The lock files the PermLang steps in these workflows read, from the repository root; steps whose lock can't be told are left out. */
export function locksRead(files: readonly string[], read: Reader): Set<string> {
  const locks = new Set<string>();
  for (const step of permLangSteps(files, read)) {
    const lock = stepLock(step);
    if (lock !== undefined) locks.add(lock);
  }
  return locks;
}

/** The lock a PermLang step reads; undefined when its inputs come from an expression, or don't parse. */
function stepLock(step: PermLangStep): string | undefined {
  const workingDirectory = step.workingDirectory ?? ".";
  const argText = step.args ?? "";
  if (`${workingDirectory}${argText}`.includes("${{")) return undefined;
  let args: Args;
  try {
    // As the Action's script splits them: on spaces, tabs, and line breaks.
    args = parseArgs("check", argText.split(/[ \t\n]+/).filter(Boolean));
  } catch {
    return undefined;
  }
  if (args.noLock) return undefined;
  const lock = (args.lock ?? DEFAULT_LOCK).replaceAll("\\", "/");
  if (path.posix.isAbsolute(lock) || /^[a-z]:/i.test(lock)) return undefined;
  return path.posix.normalize(path.posix.join(workingDirectory.replaceAll("\\", "/"), lock)).replace(/^\.\//, "");
}

/** PermLang's own Action: `PermLang/permlang@<ref>` (GitHub names are case-insensitive), or a local Action named PermLang. */
function isPermLang(uses: string, read: Reader): boolean {
  if (/^permlang\/permlang(\/[^@]*)?@/i.test(uses)) return true;
  if (!uses.startsWith("./")) return false;
  const dir = path.posix.normalize(uses.replace(/\/+$/, ""));
  for (const name of ["action.yml", "action.yaml"]) {
    const yaml = parse(read(dir === "." ? name : `${dir}/${name}`));
    if (yaml) return scalar(yaml, yaml.get(yaml.root(), "name")) === "PermLang";
  }
  return false;
}

function parse(text: string | undefined): YamlFile | undefined {
  if (text === undefined) return undefined;
  const yaml = new YamlFile(text);
  return yaml.readable ? yaml : undefined;
}

/** A key's text, when it has exactly one value that's a scalar. */
function scalar(yaml: YamlFile, values: readonly Value[]): string | undefined {
  return values.length === 1 ? yaml.text(values[0]!.node)?.trim() : undefined;
}

/** GitHub runs the .yml and .yaml files directly in .github/workflows. */
function isWorkflow(file: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file);
}

function repositoryRoot(): string {
  return realpathSync.native(git(process.cwd(), "rev-parse", "--show-toplevel").trim());
}

/**
 * What git prints. @throws when git fails: the callers have read `base` already, so this runs in
 * a repository that has it, and a failure is a problem to report, not a list to leave empty.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** What git prints, or undefined when it fails: a file that doesn't exist at the commit. */
function gitText(cwd: string, ...args: string[]): string | undefined {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
}
