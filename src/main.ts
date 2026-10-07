/**
 * What the permlang command does: init, check, lock, diff, spec (cli.ts runs it). It
 * reads sources, config, and lock files, writes the lock file, and runs `git show` to
 * read a committed lock. In GitHub Actions it reads GITHUB_WORKSPACE, so annotations
 * name files from the repository root.
 * @module
 * @perm fs.read, fs.write, exec, env(GITHUB_WORKSPACE)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AdapterError, AdapterIndex, loadAdapters } from "./adapters.js";
import { COMMANDS, DEFAULT_LOCK, USAGE, UsageError, parseArgs, type Args, type Command } from "./args.js";
import {
  STRICTNESS_LEVELS,
  UNMAPPED_POLICIES,
  checkFiles,
  checkTsConfig,
  type CheckOptions,
  type Diagnostic,
  type Report,
  type Strictness,
  type UnmappedPolicy,
} from "./check.js";
import { addedDependencies, overriddenDependencies, type DependencyChange, type PackageJson } from "./deps.js";
import { commentMarker, formatDiffFailure, formatDiffMarkdown, formatDiffText, formatNoLock, SUMMARY_LIMIT, type DiffNotes, type ViaPaths } from "./diff.js";
import { workflowArgs, workflowFile, workflowTarget } from "./init-workflow.js";
import { LOCK_VERSION, LockError, buildLock, diffLocks, isConfigKey, keyed, lockDrift, parseLock, serializeLock, type LockFile } from "./lock.js";
import { movedLocks } from "./lock-moves.js";
import { formatAnnotations, formatText, printable, toJson, toSarif } from "./report.js";
import { FlowRuleError } from "./flows.js";
import { DEFAULT_CONFIG, SettingsError, readConfig, readTsConfig, settingsEntries, type Origin, type Settings } from "./settings.js";
import { checkSpecs, formatSpecResults } from "./spec/check.js";
import { parseSpecs, type Spec, type SpecError } from "./spec/parse.js";
import { isUncheckedKey, uncheckedEntry } from "./unchecked.js";

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;
const ISSUES = "https://github.com/PermLang/PermLang/issues";

/** This package's version. package.json sits one level above both src/ and dist/. */
function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

/** Runs the command with these arguments, and returns its exit code. */
export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(packageVersion());
    return 0;
  }
  // Help only on its own: with other arguments (`args: src -h` in a workflow), printing it and
  // exiting 0 would pass a check that never ran. parseArgs rejects it there.
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h") && isCommand(command)) {
    console.log(USAGE);
    return 0;
  }
  try {
    if (!isCommand(command)) throw new UsageError(`Unknown command "${printable(command)}".\n\n${USAGE}`);
    const args = parseArgs(command, rest);
    if (command === "init") return init(args);
    if (command === "check") return check(args);
    if (command === "lock") return lock(args);
    if (command === "diff") return diff(args);
    return spec(args);
  } catch (e) {
    // The Action posts diff's markdown over its earlier comment, which would otherwise go on
    // looking current: a diff that fails, even on its arguments, still prints a comment that says so.
    if (command === "diff" && rest.some((a, i) => a === "--format" && rest[i + 1] === "markdown")) {
      console.log(e instanceof NoLockError ? formatNoLock(e.lockFile, diffMarker()) : formatDiffFailure(expectedError(e) ?? `internal error: ${errorMessage(e)}`, diffMarker()));
    }
    // Exit code 1 means permission errors and nothing else, so CI can tell a failed check from a broken one.
    console.error(expectedError(e) ?? internalError(e));
    return 2;
  }
}

function isCommand(command: string): command is Command {
  return (COMMANDS as readonly string[]).includes(command);
}

/** A diff with no lock file in the working tree or at the base commit: there's nothing to compare. */
class NoLockError extends UsageError {
  constructor(readonly lockFile: string) {
    super(`No ${lockFile}. Run \`permlang lock\` first.`);
  }
}

/** The message for an error that isn't a bug in PermLang: bad arguments or settings, or a file it can't read or write. */
function expectedError(e: unknown): string | undefined {
  if (e instanceof UsageError || e instanceof AdapterError || e instanceof LockError || e instanceof SettingsError) return e.message;
  // A system error (ENOENT, EACCES, ...) reading or writing a file.
  const error = Object(e) as NodeJS.ErrnoException;
  return /^E[A-Z]+$/.test(String(error.code)) ? printable(error.message) : undefined;
}

/** What was thrown, on one line. */
function errorMessage(e: unknown): string {
  return printable(e instanceof Error ? e.message : String(e));
}

/** A bug: the error and where it happened, to report. */
function internalError(e: unknown): string {
  const error = e instanceof Error ? e : new Error(String(e));
  // Where it happened: the stack's frames. The message before them goes on one line, like any text from outside.
  const frames = /\n {4}at [\s\S]*$/.exec(String(error.stack))?.[0] ?? "";
  return `PermLang hit an internal error. Please report it at ${ISSUES}, with this:\n${printable(`${error.name}: ${error.message}`)}${frames}`;
}

// --- commands ----------------------------------------------------------------

/** Day-one setup: a sketch-level config, optionally the workflow, then a first lock file. Each is kept if it exists. */
function init(args: Args): number {
  const done: string[] = [];
  // Settled before anything is written, so a path the Action can't use leaves nothing behind.
  const workflow = args.workflow ? workflowTarget() : undefined;
  const actionArgs = workflow ? workflowArgs(args, workflow) : "";
  const configFile = args.config ?? DEFAULT_CONFIG;
  if (existsSync(configFile)) {
    done.push(`Kept ${configFile}.`);
  } else {
    const strictness = args.strictness ?? "sketch";
    if (!STRICTNESS_LEVELS.includes(strictness as Strictness)) {
      throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
    }
    writeFileSync(configFile, `${JSON.stringify({ strictness }, null, 2)}\n`);
    const meaning = strictness === "sketch" ? ": rules are reported, not enforced; anything the lock file doesn't record still fails: new access, a changed setting, or new code PermLang can't check" : "";
    done.push(`Wrote ${configFile} (strictness ${strictness}${meaning}).`);
  }

  if (workflow) {
    if (workflow.exists) {
      done.push(`Kept ${workflow.shown}.`);
    } else {
      mkdirSync(path.dirname(workflow.file), { recursive: true });
      writeFileSync(workflow.file, workflowFile(actionArgs, workflow));
      done.push(`Wrote ${workflow.shown}: checks every pull request and comments the permission diff.`);
    }
  }

  // After the workflow, so the lock records it and the first pull request passes. An existing lock is
  // kept: rewriting it would approve whatever changed since, without anyone seeing it.
  const lockFile = path.resolve(args.lock ?? DEFAULT_LOCK);
  const lockName = path.relative(process.cwd(), lockFile).replaceAll("\\", "/");
  let unmapped = 0;
  if (existsSync(lockFile)) {
    done.push(`Kept ${lockName}. Run \`permlang lock\` to record what changed since it was written, and review the change.`);
  } else {
    // --strictness went into the config written above (or was ignored, for one kept): the lock records the config's.
    const report = analyze({ ...args, strictness: undefined });
    const lock = buildLock(report, path.dirname(lockFile));
    writeFileSync(lockFile, serializeLock(lock));
    // Configuration entries (the settings, workflows, package.json scripts) aren't functions. There's
    // always at least one: the settings the lock was written with.
    const keys = Object.keys(lock.functions);
    const reaching = keys.filter((k) => !isConfigKey(k)).length;
    const config = keys.length - reaching;
    const entries = `${plural(config, "configuration entry", "configuration entries")} ${config === 1 ? "records" : "record"} the settings and project files`;
    done.push(`Wrote ${lockName}: ${plural(reaching, "function")} ${reaching === 1 ? "reaches" : "reach"} something, across ${plural(report.files, "file")}, and ${entries}.`);
    unmapped = report.unmapped.length;
  }

  const commit = [configFile, lockName, ...(workflow ? [workflow.shown] : [])].join(", ");
  const steps = [
    `Commit ${commit}.`,
    "From now on, `permlang check` fails when code reaches something the lock doesn't record. Run `permlang lock` to accept a change, and review the lock's diff.",
    ...(unmapped > 0 ? [`Review the ${unmapped} packages with no adapter; \`permlang check\` lists them.`] : []),
    'Add @perm annotations where you want rules enforced, then raise "strictness" to development.',
  ];
  console.log([...done, "", "Next steps:", ...steps.map((s) => `  - ${s}`)].join("\n"));
  return 0;
}

function check(args: Args): number {
  if (args.noLock && args.requireLock) throw new UsageError("--no-lock and --require-lock can't be used together.");
  const lockName = args.lock ?? DEFAULT_LOCK;
  const lockFile = path.resolve(lockName);
  // With --base, the base commit decides whether the lock this check reads is required, and
  // whether the change stopped checking with the base's own lock.
  const atBase = args.base !== undefined && fileAt(args.base, lockName) !== undefined;
  if (atBase && args.noLock) throw new UsageError(`--no-lock turns off the comparison with ${printable(lockName)}, which the base commit has.`);
  const moved = args.base !== undefined ? movedLocks(args.base, args.noLock ? undefined : lockName) : [];
  let committed: { contents: LockFile; text: string } | undefined;
  if (!args.noLock) {
    if (existsSync(lockFile)) {
      const text = readText(lockName);
      committed = { contents: parseLock(text, lockName), text };
    } else if (args.lock !== undefined) {
      // A mistyped --lock would otherwise turn the comparison off.
      const shown = printable(args.lock);
      throw new UsageError(`${shown} doesn't exist. Run \`permlang lock --lock ${shown}\` to create it, or fix the path.`);
    }
  }
  const report = analyze(args);
  if (committed) report.diagnostics.push(...lockDrift(committed.contents, buildLock(report, path.dirname(lockFile)), report, lockFile, committed.text));
  else if (args.requireLock || atBase) report.diagnostics.push(missingLock(lockFile));
  if (moved.length > 0) report.diagnostics.push(movedLock(moved, lockFile, !args.noLock));
  report.diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  // Paths in annotations and SARIF are relative to the repository root in GitHub Actions.
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  // Written even with no findings, so code scanning closes alerts for fixed problems.
  if (args.sarif) writeText(args.sarif, `${toSarif(report, root, packageVersion())}\n`);
  console.log(args.json ? toJson(report) : formatText(report));
  // In GitHub Actions, each diagnostic then shows on its line in the pull request. The runner
  // reads standard error too, which keeps --json's output valid JSON.
  if (args.githubAnnotations && report.diagnostics.length > 0) (args.json ? console.error : console.log)(formatAnnotations(report, root));
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/** --require-lock with no lock file: the comparison that catches new access can't run. */
function missingLock(lockFile: string): Diagnostic {
  const name = path.basename(lockFile);
  return {
    severity: "error",
    code: "PERM005",
    file: lockFile,
    line: 1,
    column: 1,
    function: "<lock>",
    capability: "",
    call: "",
    message: `${name} is missing. Without it, new access can't be told from old.`,
    fix: `restore ${name}, or run \`permlang lock\` and commit it so reviewers see everything it records.`,
  };
}

/** --base, when the change stops checking with the lock file the base commit's workflows check with. */
function movedLock(moved: readonly string[], lockFile: string, reads: boolean): Diagnostic {
  const old = moved.map(printable).join(", ");
  const instead = reads ? `, and this check reads ${printable(path.basename(lockFile))} instead` : "";
  return {
    severity: "error",
    code: "PERM005",
    file: lockFile,
    line: 1,
    column: 1,
    function: "<lock>",
    capability: "",
    call: "",
    message: `This change stops checking with ${old}, which the base commit's workflow checks with${instead}. A lock file the base doesn't check with can approve whatever the change adds.`,
    fix: `keep checking with ${old}. To move a lock file, first add a check that reads the new one next to the old, and once that's merged, remove the old one.`,
  };
}

/** Checks .perm specs' permissions against the code that implements them (phase 2 groundwork). */
function spec(args: Args): number {
  const files = args.specs.length > 0 ? args.specs : findSpecFiles(".");
  const vocabulary = new AdapterIndex(loadAdapters([...args.adapters, ...readConfig(args.config).adapters]).adapters).vocabulary;
  const specs: Spec[] = [];
  const errors: SpecError[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new UsageError(`Not found: ${printable(file)}`);
    const parsed = parseSpecs(readFileSync(file, "utf8"), path.resolve(file), vocabulary);
    specs.push(...parsed.specs);
    errors.push(...parsed.errors);
  }
  const results = checkSpecs(specs, analyze(args));

  if (args.json) {
    console.log(JSON.stringify({ errors, results: results.map(({ spec: s, ...r }) => ({ spec: s.name, file: s.file, ...r })) }, null, 2));
  } else {
    for (const e of errors) console.log(`${printable(path.relative(process.cwd(), e.file).replaceAll("\\", "/"))}:${e.line} error SPEC001: ${printable(e.message)}`);
    if (errors.length > 0) console.log("");
    console.log(formatSpecResults(results));
  }
  // A spec that can't be read is an error of its own (2): 1 means permission errors and nothing else.
  if (errors.length > 0) return 2;
  return results.some((r) => r.diagnostics.some((d) => d.severity === "error")) ? 1 : 0;
}

function findSpecFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".perm") && !f.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith(".")))
    .map((f) => path.join(root, f));
}

function lock(args: Args): number {
  const lockName = args.lock ?? DEFAULT_LOCK;
  const lockFile = path.resolve(lockName);
  const notes: string[] = [];
  let previous: LockFile | undefined;
  if (existsSync(lockFile)) {
    try {
      previous = parseLock(readText(lockName), lockName);
    } catch (e) {
      // Every lock error says to run `permlang lock`, so it must be able to start over. (Reading
      // and parsing throw only UsageError and LockError.)
      notes.push(`Couldn't read the old ${path.basename(lockFile)} (${(e as Error).message}), so this writes a new one: review all of it.`);
    }
  }
  const report = analyze(args);
  const next = buildLock(report, path.dirname(lockFile));
  writeText(lockFile, serializeLock(next));
  if (previous && previous.permlang !== LOCK_VERSION) notes.push(`Updated ${path.basename(lockFile)} from lock format ${previous.permlang} to ${LOCK_VERSION}, which also records the check's settings.`);
  const changes = formatDiffText(diffLocks(previous, next), viaPaths(report, path.dirname(lockFile)));
  const keys = Object.keys(next.functions);
  const functions = keys.filter((k) => !isConfigKey(k) && !isUncheckedKey(k)).length;
  const counts = `${plural(functions, "function")}, ${plural(keys.length - functions, "configuration entry", "configuration entries")}`;
  console.log([`Wrote ${path.relative(process.cwd(), lockFile)} (${counts}).`, ...notes, changes].join("\n\n"));
  return 0;
}

/** Each folder of a repository gets its own comment: the marker names the folder. */
function diffMarker(): string {
  return commentMarker(path.relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.cwd()));
}

/** When it fails, its markdown is still a comment that says so: see main(). */
function diff(args: Args): number {
  // --json is short for --format json. A --format wins: the Action adds --format markdown after its args.
  const format = args.format ?? (args.json ? "json" : "text");
  if (!["text", "markdown", "json"].includes(format)) throw new UsageError(`--format must be text, markdown, or json.`);
  // diff [base-ref] [paths...]: the paths select the code analyzed for "reached through".
  const [base = "HEAD", ...sources] = args.paths;
  const lockName = args.lock ?? DEFAULT_LOCK;
  const root = path.dirname(path.resolve(lockName));

  const baseLock = lockAt(base, lockName);
  const notes: DiffNotes = {
    lockFile: path.basename(lockName),
    enforced: !args.noLock,
    baseMissing: baseLock === undefined,
    baseOutdated: baseLock?.permlang === 1,
    marker: diffMarker(),
  };
  let headLock: LockFile;
  let via: ViaPaths = {};
  // For each capability, the AI tools that can trigger it (from analyzing the working tree).
  const aiTools: Record<string, string[]> = {};
  if (args.head) {
    const found = lockAt(args.head, lockName);
    if (!found) throw new UsageError(`${lockName} doesn't exist at ${printable(args.head)}.`);
    headLock = found;
  } else {
    const diskLock = existsSync(lockName) ? parseLock(readText(lockName), lockName) : undefined;
    // A change can leave the base's lock behind by checking with another one, or with none, which
    // the check fails. Then there's a diff to show even when neither commit has this lock file.
    notes.lockMoved = movedLocks(base, args.noLock ? undefined : lockName);
    if (!diskLock && !baseLock && notes.lockMoved.length === 0) throw new NoLockError(lockName);
    // A pull request that deletes the lock turns the comparison off: the comment must say so.
    notes.lockDeleted = diskLock === undefined && baseLock !== undefined;
    notes.lockOutdated = diskLock?.permlang === 1;
    headLock = diskLock ?? { permlang: LOCK_VERSION, functions: {}, unsafe: {} };
    // The working tree is the truth: diff the base against what the code reaches now, not only
    // what the lock says, and note where the two differ (the check fails on that). If the code
    // can't be analyzed, the diff shows the lock files alone, and says so.
    try {
      const report = analyze({ ...args, paths: sources });
      via = viaPaths(report, root);
      for (const t of report.tools) for (const c of t.reaches) (aiTools[c] ??= []).push(t.name);
      const codeLock = buildLock(report, root);
      if (diskLock) notes.pending = diffLocks(diskLock, codeLock);
      headLock = codeLock;
    } catch (e) {
      const expected = expectedError(e);
      if (expected === undefined) console.error(internalError(e));
      notes.analysisError = expected ?? `internal error: ${errorMessage(e)}`;
    }
  }

  const changes = diffLocks(baseLock, headLock);
  notes.dependencies = dependencyChanges(base, args);
  notes.aiTools = aiTools;
  if (format === "json") {
    const p = notes.pending;
    const unrecorded = p && p.functions.length + p.unsafeAdded.length + p.unsafeRemoved.length + p.unsafeChanged.length > 0 ? p : null;
    const status = { analysisError: notes.analysisError ?? null, lockDeleted: notes.lockDeleted === true, lockMoved: notes.lockMoved ?? [], baseLockMissing: notes.baseMissing === true };
    console.log(JSON.stringify({ base, head: args.head ?? "working tree", ...changes, via, unrecorded, ...status, dependencies: notes.dependencies, aiTools }, null, 2));
  } else {
    console.log(format === "markdown" ? formatDiffMarkdown(changes, via, notes) : formatDiffText(changes, via, notes));
  }
  // For a job summary, which takes far more than a comment: the diff uncut, or nearly.
  if (args.summary) writeText(args.summary, `${formatDiffMarkdown(changes, via, notes, SUMMARY_LIMIT)}\n`);
  return 0;
}

// --- helpers -----------------------------------------------------------------

/** Settings, files, and lock entries for one run. */
function analyze(args: Args): Report {
  const root = path.dirname(path.resolve(args.lock ?? DEFAULT_LOCK));
  const settings = settingsFor(args);
  const options: CheckOptions = {
    adapters: settings.adapters.map((a) => a.file),
    strictness: settings.strictness.value as Strictness,
    unmapped: settings.unmapped.value as UnmappedPolicy,
    tools: settings.tools.value as UnmappedPolicy,
    flows: settings.flows,
    // Workflows, Actions, and package.json scripts, from the folder the lock lives in.
    projectRoot: root,
  };
  const scope = settings.scope;
  const selected = "project" in scope ? readTsConfig(scope.project).fileNames : scope.paths.flatMap(expand);
  let report: Report;
  try {
    report = "project" in scope ? checkTsConfig(scope.project, options) : checkFiles(selected, options);
  } catch (e) {
    // A flow rule can only be checked against the adapters once they're loaded.
    if (e instanceof FlowRuleError) throw new SettingsError(`${path.relative(process.cwd(), settings.configFile)}: ${e.message}`);
    throw e;
  }
  // What the check ran on and with is recorded in the lock, like what the code reaches, and so
  // are the files it read only because the selected ones import them, and the code it couldn't check.
  report.functions.push(...settingsEntries(settings, root, importedFiles(report, selected)));
  const unchecked = uncheckedEntry(report, settings.configFile, root);
  if (unchecked.actual.length > 0) report.functions.push(unchecked);
  return report;
}

/** The files analyzed that the paths or the tsconfig.json didn't select: the ones they import. */
function importedFiles(report: Report, selected: readonly string[]): string[] {
  // Windows paths differ in case and separator between Node and TypeScript; the file is the same.
  const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file));
  const chosen = new Set(selected.map(key));
  return [...new Set(report.units.map((u) => u.file))].filter((file) => !chosen.has(key(file)));
}

/**
 * The settings in effect: each command-line option, else the config file, else the default.
 * @throws UsageError or SettingsError for a value that isn't valid, or files that don't exist.
 */
function settingsFor(args: Args): Settings {
  const config = readConfig(args.config);
  const configName = config.file ?? args.config ?? DEFAULT_CONFIG;
  const pick = (option: string | undefined, fromConfig: unknown, fallback: string): { value: string; from: Origin } =>
    option !== undefined ? { value: option, from: "option" } : fromConfig !== undefined ? { value: String(fromConfig), from: "config" } : { value: fallback, from: "default" };

  if (config.strictness !== undefined && typeof config.strictness !== "string") {
    throw new UsageError(`${configName}: "strictness" must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  const strictness = pick(args.strictness, config.strictness, "development");
  if (!STRICTNESS_LEVELS.includes(strictness.value as Strictness)) throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  const unmapped = pick(args.unmapped, config.unmapped, "warn");
  if (!UNMAPPED_POLICIES.includes(unmapped.value as UnmappedPolicy)) throw new UsageError(`"unmapped" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);
  const tools = pick(undefined, config.tools, "warn");
  if (!UNMAPPED_POLICIES.includes(tools.value as UnmappedPolicy)) throw new UsageError(`"tools" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);

  let scope: Settings["scope"];
  if (args.project !== undefined) {
    readTsConfig(args.project);
    scope = { project: args.project, found: false };
  } else if (args.paths.length === 0 && existsSync("tsconfig.json")) {
    readTsConfig("tsconfig.json");
    scope = { project: "tsconfig.json", found: true };
  } else {
    const targets = args.paths.length > 0 ? args.paths : ["src"];
    const missing = targets.filter((p) => !existsSync(p));
    if (missing.length > 0) throw new UsageError(`Not found: ${missing.map(printable).join(", ")}`);
    // A check of nothing would pass.
    if (targets.flatMap(expand).length === 0) throw new UsageError(`No TypeScript files in ${targets.map(printable).join(", ")}.`);
    scope = { paths: targets, given: args.paths.length > 0 };
  }
  return {
    configFile: path.resolve(configName),
    strictness,
    unmapped,
    tools,
    flows: config.flows ?? [],
    adapters: [...args.adapters.map((file) => ({ file: path.resolve(file), from: "option" as const })), ...config.adapters.map((file) => ({ file, from: "config" as const }))],
    scope,
  };
}

/** The lock file as committed at `ref`, or undefined if it didn't exist there. */
function lockAt(ref: string, lockFile: string): LockFile | undefined {
  const found = fileAt(ref, lockFile);
  return found && parseLock(found.text, found.spec);
}

/** A file's contents at a commit, or undefined when it doesn't exist there. */
function fileAt(ref: string, file: string): { text: string; spec: string } | undefined {
  // git resolves `ref:./path` relative to the working directory, so an absolute path is made relative.
  const relative = path.relative(process.cwd(), path.resolve(file)).replaceAll("\\", "/");
  const spec = `${ref}:./${relative}`;
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const failed = (e: unknown) => String((e as { stderr?: unknown }).stderr ?? "").trim() || (e as Error).message;
  // After --end-of-options, a ref that starts with "-" can't be read as an option.
  try {
    // First, that the commit is here: for a full hash it doesn't have, `git show` only says the file isn't in it.
    git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "git can't be run" : "it isn't a commit in this repository; fetch it first";
    throw new UsageError(`Can't read ${file} at ${printable(ref)}: ${why} (${printable(failed(e))}).`);
  }
  try {
    return { text: git("show", "--end-of-options", spec), spec };
  } catch (e) {
    if (/does not exist|exists on disk, but not in/.test(failed(e))) return undefined;
    throw new UsageError(`Can't read ${file} at ${printable(ref)}: ${printable(failed(e))}`);
  }
}

/**
 * Packages the change adds to ./package.json, installs from another source, or overrides, for
 * review. A package.json that's missing or isn't a JSON object means no dependency section, and
 * adapters that can't be loaded (which fails the analysis, and the comment says so) are left out.
 * The commits were read already, so a failure to read them here is an error.
 */
function dependencyChanges(base: string, args: Args): DependencyChange[] {
  const head = parsePackage(args.head ? fileAt(args.head, "package.json")?.text : existsSync("package.json") ? readFileSync("package.json", "utf8") : undefined);
  if (!head) return [];
  const installed = (name: string) => {
    const file = path.join("node_modules", name, "package.json");
    return existsSync(file) ? parsePackage(readFileSync(file, "utf8")) : undefined;
  };
  const before = parsePackage(fileAt(base, "package.json")?.text);
  const adapters = dependencyAdapters(args);
  return [...addedDependencies(before, head, adapters, installed), ...overriddenDependencies(before, head, adapters, installed)];
}

function parsePackage(text: string | undefined): PackageJson | undefined {
  if (text === undefined) return undefined;
  try {
    const pkg: unknown = JSON.parse(text);
    return typeof pkg === "object" && pkg !== null ? (pkg as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function dependencyAdapters(args: Args): AdapterIndex {
  let files: string[] = [];
  try {
    files = [...args.adapters, ...readConfig(args.config).adapters];
  } catch {
    // A config file that can't be read: the analysis reports it.
  }
  // The manifests that load, with the built-in ones: one that doesn't fails the analysis, which the diff says.
  return new AdapterIndex(loadAdapters(files).adapters);
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function viaPaths(report: Report, root: string): ViaPaths {
  return Object.fromEntries(keyed(report, root).map(({ key, fn }) => [key, fn.via]));
}

/** A file's text. @throws UsageError when it can't be read (missing, a folder, no permission). */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`Can't read ${printable(file)}: ${printable((e as Error).message)}`);
  }
}

/** @throws UsageError when the file can't be written (no such folder, no permission). */
function writeText(file: string, text: string): void {
  try {
    writeFileSync(file, text);
  } catch (e) {
    throw new UsageError(`Can't write ${printable(file)}: ${printable((e as Error).message)}`);
  }
}

/** A file, or every TypeScript source under a directory (declaration files included, for their types). */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}
