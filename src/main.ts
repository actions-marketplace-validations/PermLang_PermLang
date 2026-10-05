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
import {
  STRICTNESS_LEVELS,
  UNMAPPED_POLICIES,
  checkFiles,
  checkTsConfig,
  type CheckOptions,
  type Report,
  type Strictness,
  type UnmappedPolicy,
} from "./check.js";
import { addedDependencies, type DependencyChange, type PackageJson } from "./deps.js";
import { formatDiffMarkdown, formatDiffText, type DiffNotes, type ViaPaths } from "./diff.js";
import { parseFlows, type FlowRule } from "./flows.js";
import { LockError, buildLock, diffLocks, keyed, parseLock, serializeLock, type LockDiff, type LockFile } from "./lock.js";
import { formatAnnotations, formatText, toJson, toSarif } from "./report.js";
import { checkSpecs, formatSpecResults } from "./spec/check.js";
import { parseSpecs, type Spec, type SpecError } from "./spec/parse.js";

const USAGE = `Usage:
  permlang --version                     print the version
  permlang init  [paths...] [options]    set up: a sketch-level config and a first lock file
  permlang check [paths...] [options]    check permissions (and the lock file, if there is one)
  permlang lock  [paths...] [options]    write permlang.lock.json from the current code
  permlang diff  [base-ref] [paths...]   permission changes since base-ref (default HEAD)
  permlang spec  [paths...] [options]    check .perm specs against the code (phase 2 groundwork)

Which files: paths, or --project <tsconfig.json>. With neither, ./tsconfig.json
if present, else ./src.

Options:
  --project, -p <tsconfig.json>   check the files of a TypeScript project
  --config <file>                 config file (default: ./permlang.config.json if present)
  --adapter <file.json>           add an adapter manifest (repeatable)
  --strictness <level>            sketch | development | production (default: development)
  --unmapped <policy>             packages with no adapter: warn | error | trust (default: warn)
  --lock <file>                   lock file (default: ./permlang.lock.json)
  --no-lock                       check: don't compare against the lock file
  --json                          check: print the JSON report
  --github-annotations            check: also print a GitHub Actions annotation per diagnostic
  --sarif <file>                  check: also write the findings as SARIF, for GitHub code scanning
  --head <ref>                    diff: compare against this commit instead of the working tree
  --format <text|markdown|json>   diff: output format (default: text)
  --workflow                      init: also add .github/workflows/permlang.yml
  --spec <file.perm>              spec: check this spec (repeatable; default: every .perm file here)

permlang.config.json:
  { "strictness": "sketch", "unmapped": "warn", "adapters": ["./permlang/adapters/acme-sms.json"] }
  Also "tools": "warn" | "error" | "trust", and "flows": [{ "from": "env(KEY)", "to": ["net(host)"] }].

Exit codes: 0 no errors, 1 permission errors, 2 usage or configuration error.`;

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/;
const DEFAULT_CONFIG = "permlang.config.json";
const DEFAULT_LOCK = "permlang.lock.json";

class UsageError extends Error {}

interface Args {
  paths: string[];
  adapters: string[];
  project?: string;
  config?: string;
  strictness?: string;
  unmapped?: string;
  lock?: string;
  noLock: boolean;
  workflow: boolean;
  specs: string[];
  json: boolean;
  githubAnnotations: boolean;
  sarif?: string;
  head?: string;
  format: string;
}

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
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  try {
    const args = parseArgs(rest);
    if (command === "init") return init(args);
    if (command === "check") return check(args);
    if (command === "lock") return lock(args);
    if (command === "diff") return diff(args);
    if (command === "spec") return spec(args);
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  } catch (e) {
    if (e instanceof UsageError || e instanceof AdapterError || e instanceof LockError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

function parseArgs(rest: string[]): Args {
  const args: Args = { paths: [], adapters: [], specs: [], noLock: false, workflow: false, json: false, githubAnnotations: false, format: "text" };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value.`);
      return v;
    };
    if (arg === "--json") args.json = true;
    else if (arg === "--github-annotations") args.githubAnnotations = true;
    else if (arg === "--sarif") args.sarif = value();
    else if (arg === "--no-lock") args.noLock = true;
    else if (arg === "--workflow") args.workflow = true;
    else if (arg === "--spec") args.specs.push(value());
    else if (arg === "--project" || arg === "-p") args.project = value();
    else if (arg === "--config") args.config = value();
    else if (arg === "--adapter") args.adapters.push(value());
    else if (arg === "--strictness") args.strictness = value();
    else if (arg === "--unmapped") args.unmapped = value();
    else if (arg === "--lock") args.lock = value();
    else if (arg === "--head") args.head = value();
    else if (arg === "--format") args.format = value();
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".\n\n${USAGE}`);
    else args.paths.push(arg);
  }
  return args;
}

// --- commands ----------------------------------------------------------------

/** Day-one setup: a sketch-level config (unless one exists), a first lock file, optionally the workflow. */
function init(args: Args): number {
  const done: string[] = [];
  const configFile = args.config ?? DEFAULT_CONFIG;
  if (existsSync(configFile)) {
    done.push(`Kept ${configFile}.`);
  } else {
    const strictness = args.strictness ?? "sketch";
    if (!STRICTNESS_LEVELS.includes(strictness as Strictness)) {
      throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
    }
    writeFileSync(configFile, `${JSON.stringify({ strictness }, null, 2)}\n`);
    const meaning = strictness === "sketch" ? ": rules are reported, not enforced; new access the lock file doesn't record still fails" : "";
    done.push(`Wrote ${configFile} (strictness ${strictness}${meaning}).`);
  }

  const lockFile = path.resolve(args.lock ?? DEFAULT_LOCK);
  const report = analyze(args, undefined);
  const lock = buildLock(report, path.dirname(lockFile));
  writeFileSync(lockFile, serializeLock(lock));
  const lockName = path.relative(process.cwd(), lockFile).replaceAll("\\", "/");
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const reaching = Object.keys(lock.functions).length;
  done.push(`Wrote ${lockName}: ${count(reaching, "function")} ${reaching === 1 ? "reaches" : "reach"} something, across ${count(report.files, "file")}.`);

  const workflow = ".github/workflows/permlang.yml";
  if (args.workflow) {
    if (existsSync(workflow)) {
      done.push(`Kept ${workflow}.`);
    } else {
      mkdirSync(path.dirname(workflow), { recursive: true });
      writeFileSync(workflow, workflowFile(args));
      done.push(`Wrote ${workflow}: checks every pull request and comments the permission diff.`);
    }
  }

  const commit = [configFile, lockName, ...(args.workflow ? [workflow] : [])].join(", ");
  const steps = [
    `Commit ${commit}.`,
    "From now on, `permlang check` fails when code reaches something the lock doesn't record. Run `permlang lock` to accept a change, and review the lock's diff.",
    ...(report.unmapped.length > 0 ? [`Review the ${report.unmapped.length} packages with no adapter; \`permlang check\` lists them.`] : []),
    'Add @perm annotations where you want rules enforced, then raise "strictness" to development.',
  ];
  console.log([...done, "", "Next steps:", ...steps.map((s) => `  - ${s}`)].join("\n"));
  return 0;
}

/** A workflow that runs the PermLang Action on the same files init checked. */
/**
 * How to install the project's dependencies in CI, from its lockfile. PermLang reads code through
 * the TypeScript compiler: without the dependencies' types (`@types/node` above all), file, process,
 * and environment access are invisible. Install scripts are skipped; they aren't needed for types.
 */
function installSteps(): string[] {
  if (existsSync("pnpm-lock.yaml")) return ["      - run: corepack enable", "      - run: pnpm install --frozen-lockfile --ignore-scripts"];
  if (existsSync("yarn.lock")) return ["      - run: corepack enable", "      - run: yarn install --ignore-scripts"];
  if (existsSync("package-lock.json")) return ["      - run: npm ci --ignore-scripts --no-audit --no-fund"];
  return ["      - run: npm install --ignore-scripts --no-audit --no-fund"];
}

function workflowFile(args: Args): string {
  const selection = args.project ? `--project ${args.project}` : args.paths.join(" ");
  const withArgs = selection ? `\n        with:\n          args: ${selection}` : "";
  return [
    "name: PermLang",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  permissions:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - uses: actions/setup-node@v7",
    "        with:",
    "          node-version: lts/*",
    "      # PermLang needs your dependencies' types (@types/node above all) to see file, process,",
    "      # and environment access. If you generate code, such as `prisma generate`, add it here too.",
    ...installSteps(),
    `      - uses: PermLang/permlang@v0${withArgs}`,
    "",
  ].join("\n");
}

function check(args: Args): number {
  const lockFile = args.lock ?? DEFAULT_LOCK;
  const useLock = !args.noLock && existsSync(lockFile);
  const lock = useLock ? { file: path.resolve(lockFile), contents: parseLock(readFileSync(lockFile, "utf8"), lockFile) } : undefined;
  const report = analyze(args, lock);
  console.log(args.json ? toJson(report) : formatText(report));
  // In GitHub Actions, each diagnostic then shows on its line in the pull request.
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  if (args.githubAnnotations && report.diagnostics.length > 0) console.log(formatAnnotations(report, root));
  // Written even with no findings, so code scanning closes alerts for fixed problems.
  if (args.sarif) writeFileSync(args.sarif, `${toSarif(report, root, packageVersion())}\n`);
  return report.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/** Checks .perm specs' permissions against the code that implements them (phase 2 groundwork). */
function spec(args: Args): number {
  const files = args.specs.length > 0 ? args.specs : findSpecFiles(".");
  const vocabulary = new AdapterIndex(loadAdapters([...args.adapters, ...readConfig(args.config).adapters]).adapters).vocabulary;
  const specs: Spec[] = [];
  const errors: SpecError[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new UsageError(`Not found: ${file}`);
    const parsed = parseSpecs(readFileSync(file, "utf8"), path.resolve(file), vocabulary);
    specs.push(...parsed.specs);
    errors.push(...parsed.errors);
  }
  const results = checkSpecs(specs, analyze(args, undefined));

  if (args.json) {
    console.log(JSON.stringify({ errors, results: results.map(({ spec: s, ...r }) => ({ spec: s.name, file: s.file, ...r })) }, null, 2));
  } else {
    for (const e of errors) console.log(`${path.relative(process.cwd(), e.file).replaceAll("\\", "/")}:${e.line} error SPEC001: ${e.message}`);
    if (errors.length > 0) console.log("");
    console.log(formatSpecResults(results));
  }
  const failed = errors.length > 0 || results.some((r) => r.diagnostics.some((d) => d.severity === "error"));
  return failed ? 1 : 0;
}

function findSpecFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".perm") && !f.split(/[\\/]/).some((part) => part === "node_modules" || part.startsWith(".")))
    .map((f) => path.join(root, f));
}

function lock(args: Args): number {
  const lockFile = path.resolve(args.lock ?? DEFAULT_LOCK);
  const previous = existsSync(lockFile) ? parseLock(readFileSync(lockFile, "utf8"), lockFile) : undefined;
  const report = analyze(args, undefined);
  const next = buildLock(report, path.dirname(lockFile));
  writeFileSync(lockFile, serializeLock(next));
  const changes = formatDiffText(diffLocks(previous, next), viaPaths(report, path.dirname(lockFile)));
  console.log(`Wrote ${path.relative(process.cwd(), lockFile) || lockFile} (${Object.keys(next.functions).length} functions).\n\n${changes}`);
  return 0;
}

function diff(args: Args): number {
  if (!["text", "markdown", "json"].includes(args.format)) throw new UsageError(`--format must be text, markdown, or json.`);
  // diff [base-ref] [paths...]: the paths select the code analyzed for "reached through".
  const [base = "HEAD", ...sources] = args.paths;
  const lockFile = args.lock ?? DEFAULT_LOCK;

  const baseLock = lockAt(base, lockFile);
  let headLock: LockFile;
  let via: ViaPaths = {};
  // For each capability, the AI tools that can trigger it (from analyzing the working tree).
  const aiTools: Record<string, string[]> = {};
  // Access the code reaches that the committed lock doesn't record. A pull request that adds
  // access without running `permlang lock` must still show it: the comment is what reviewers read.
  let unrecorded: LockDiff | undefined;
  if (args.head) {
    const found = lockAt(args.head, lockFile);
    if (!found) throw new UsageError(`${lockFile} doesn't exist at ${args.head}.`);
    headLock = found;
  } else {
    if (!existsSync(lockFile)) throw new UsageError(`No ${lockFile}. Run \`permlang lock\` first.`);
    const diskLock = parseLock(readFileSync(lockFile, "utf8"), lockFile);
    headLock = diskLock;
    // The working tree is the truth: diff the base against what the code reaches now, not only
    // what the lock says. If the code can't be analyzed, fall back to the lock file alone.
    try {
      const root = path.dirname(path.resolve(lockFile));
      const report = analyze({ ...args, paths: sources }, undefined);
      via = viaPaths(report, root);
      for (const t of report.tools) for (const c of t.reaches) (aiTools[c] ??= []).push(t.name);
      const codeLock = buildLock(report, root);
      const pending = diffLocks(diskLock, codeLock);
      if (pending.functions.some((f) => f.added.length > 0) || pending.unsafeAdded.length > 0) unrecorded = pending;
      headLock = codeLock;
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.error(`Showing the diff without paths: ${e.message}`);
    }
  }

  const changes = diffLocks(baseLock, headLock);
  const dependencies = dependencyChanges(base, args);
  const notes: DiffNotes = { unrecorded: unrecorded !== undefined, lockFile: path.basename(lockFile), dependencies, aiTools };
  if (args.format === "json") console.log(JSON.stringify({ base, head: args.head ?? "working tree", ...changes, via, unrecorded: unrecorded ?? null, dependencies, aiTools }, null, 2));
  else console.log(args.format === "markdown" ? formatDiffMarkdown(changes, via, notes) : formatDiffText(changes, via, notes));
  return 0;
}

// --- helpers -----------------------------------------------------------------

function flowsOrUsageError(raw: unknown, file: string): FlowRule[] {
  try {
    return parseFlows(raw, file);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function analyze(args: Args, lock: CheckOptions["lock"]): Report {
  const config = readConfig(args.config);
  const strictness = args.strictness ?? config.strictness;
  if (strictness !== undefined && !STRICTNESS_LEVELS.includes(strictness as Strictness)) {
    throw new UsageError(`Strictness must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  const unmapped = args.unmapped ?? config.unmapped;
  if (unmapped !== undefined && !UNMAPPED_POLICIES.includes(unmapped as UnmappedPolicy)) {
    throw new UsageError(`"unmapped" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);
  }
  if (config.tools !== undefined && !UNMAPPED_POLICIES.includes(config.tools as UnmappedPolicy)) {
    throw new UsageError(`"tools" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);
  }
  const options: CheckOptions = {
    adapters: [...args.adapters, ...config.adapters],
    ...(strictness ? { strictness: strictness as Strictness } : {}),
    ...(unmapped ? { unmapped: unmapped as UnmappedPolicy } : {}),
    ...(config.tools ? { tools: config.tools as UnmappedPolicy } : {}),
    ...(config.flows ? { flows: config.flows } : {}),
    ...(lock ? { lock } : {}),
    // Workflows, Actions, and package.json scripts, from the folder the lock lives in.
    projectRoot: path.dirname(path.resolve(args.lock ?? DEFAULT_LOCK)),
  };

  if (args.project !== undefined) return checkTsConfig(args.project, options);
  if (args.paths.length === 0 && existsSync("tsconfig.json")) return checkTsConfig("tsconfig.json", options);
  const targets = args.paths.length > 0 ? args.paths : ["src"];
  const missing = targets.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new UsageError(`Not found: ${missing.join(", ")}`);
  return checkFiles(targets.flatMap(expand), options);
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
  try {
    return { text: execFileSync("git", ["show", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), spec };
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "");
    if (/does not exist|exists on disk, but not in/.test(stderr)) return undefined;
    throw new UsageError(`Can't read ${file} at ${ref}: ${stderr.trim() || (e as Error).message}`);
  }
}

/**
 * Packages the change adds to ./package.json, for review. Best effort: a missing or
 * unreadable package.json means no dependency section, never a failed diff.
 */
function dependencyChanges(base: string, args: Args): DependencyChange[] {
  const parse = (text: string | undefined): PackageJson | undefined => {
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as PackageJson;
    } catch {
      return undefined;
    }
  };
  try {
    const head = parse(args.head ? fileAt(args.head, "package.json")?.text : existsSync("package.json") ? readFileSync("package.json", "utf8") : undefined);
    if (!head) return [];
    const adapters = new AdapterIndex(loadAdapters([...args.adapters, ...readConfig(args.config).adapters]).adapters);
    const installed = (name: string) => {
      const file = path.join("node_modules", name, "package.json");
      return existsSync(file) ? parse(readFileSync(file, "utf8")) : undefined;
    };
    return addedDependencies(parse(fileAt(base, "package.json")?.text), head, adapters, installed);
  } catch (e) {
    if (e instanceof UsageError) return [];
    throw e;
  }
}

function viaPaths(report: Report, root: string): ViaPaths {
  return Object.fromEntries(keyed(report, root).map(({ key, fn }) => [key, fn.via]));
}

interface Config {
  strictness?: string;
  unmapped?: string;
  tools?: string;
  flows?: FlowRule[];
  adapters: string[];
}

/** permlang.config.json, with adapter paths resolved relative to it. */
function readConfig(explicit: string | undefined): Config {
  const file = explicit ?? (existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
  if (file === undefined) return { adapters: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`Can't read ${file}: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UsageError(`${file}: must be a JSON object.`);
  const config = raw as { adapters?: unknown; strictness?: unknown; unmapped?: unknown; tools?: unknown; flows?: unknown };
  const list = config.adapters ?? [];
  if (!Array.isArray(list) || !list.every((a) => typeof a === "string")) {
    throw new UsageError(`${file}: "adapters" must be a list of manifest paths.`);
  }
  if (config.strictness !== undefined && typeof config.strictness !== "string") {
    throw new UsageError(`${file}: "strictness" must be one of: ${STRICTNESS_LEVELS.join(", ")}.`);
  }
  return {
    adapters: list.map((a) => path.resolve(path.dirname(file), a)),
    ...(config.strictness ? { strictness: config.strictness } : {}),
    ...(typeof config.unmapped === "string" ? { unmapped: config.unmapped } : {}),
    ...(typeof config.tools === "string" ? { tools: config.tools } : {}),
    ...(config.flows !== undefined ? { flows: flowsOrUsageError(config.flows, file) } : {}),
  };
}

/** A file, or every TypeScript source under a directory (declaration files included, for their types). */
function expand(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => SOURCE_EXTENSIONS.test(f) && !f.split(/[\\/]/).includes("node_modules"))
    .map((f) => path.join(target, f));
}

