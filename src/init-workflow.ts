/**
 * The GitHub workflow `permlang init --workflow` writes: the PermLang Action, on the files and
 * with the settings init checked, after installing the project's dependencies. Everything about
 * it is settled before init writes anything, so a path the Action can't use leaves nothing behind.
 * @module
 * @perm fs.read, exec
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { UsageError, type Args } from "./args.js";
import { UNMAPPED_POLICIES, type UnmappedPolicy } from "./check.js";
import { permLangSteps } from "./lock-moves.js";
import { printable } from "./report.js";

export interface WorkflowTarget {
  /** The repository root, where GitHub reads workflows. */
  root: string;
  /** The project's folder, where init runs. */
  cwd: string;
  file: string;
  /** `file` as shown to the user, relative to where init runs. */
  shown: string;
  /** Where the project is, relative to the root, when init runs in a subfolder (a monorepo package). */
  workingDirectory?: string;
  /** A workflow for this folder is there already. */
  exists: boolean;
}

/**
 * GitHub only runs workflows from .github/workflows at the repository root. A subfolder's is named
 * after it; when another folder's workflow has that name already (`packages/web` and
 * `packages_web`), this one's name gets a hash of the folder's path.
 * @throws UsageError when the folder's name can't go in a workflow.
 */
export function workflowTarget(): WorkflowTarget {
  const cwd = realpathSync.native(process.cwd());
  const root = gitRoot() ?? cwd;
  const sub = path.relative(root, cwd).replaceAll("\\", "/");
  const at = (name: string) => path.join(root, ".github", "workflows", name);
  const target = (file: string, exists: boolean): WorkflowTarget => ({
    root,
    cwd,
    file,
    shown: path.relative(cwd, file).replaceAll("\\", "/"),
    exists,
    ...(sub ? { workingDirectory: checked(sub, "folder") } : {}),
  });
  if (!sub) return target(at("permlang.yml"), existsSync(at("permlang.yml")));
  const slug = sub.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const hash = createHash("sha256").update(sub).digest("hex").slice(0, 8);
  for (const name of [`permlang-${slug}.yml`, `permlang-${slug}-${hash}.yml`]) {
    if (!existsSync(at(name))) return target(at(name), false);
    if (isOwn(root, at(name), sub)) return target(at(name), true);
  }
  throw new UsageError(`.github/workflows has workflows that run PermLang in other folders under both names this one would get (permlang-${slug}.yml, and with -${hash}). Add a PermLang step for ${printable(sub)} to one of them.`);
}

/**
 * Whether an existing workflow is this folder's: it runs PermLang there, or PermLang can't tell
 * where it runs it (no PermLang step it can read, or a folder from an expression), and init keeps
 * it as before. One that runs PermLang only in other folders isn't.
 */
function isOwn(root: string, file: string, folder: string): boolean {
  const read = (f: string) => (existsSync(path.resolve(root, f)) ? readFileSync(path.resolve(root, f), "utf8") : undefined);
  const steps = permLangSteps([file], read);
  if (steps.length === 0 || steps.some((s) => s.workingDirectory?.includes("${{"))) return true;
  return steps.some((s) => path.posix.normalize((s.workingDirectory ?? ".").replaceAll("\\", "/")).replace(/\/$/, "") === folder);
}

/** The repository's root, or undefined outside a repository (where git fails, or an old git prints nothing, which realpath fails on too). */
function gitRoot(): string | undefined {
  try {
    return realpathSync.native(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return undefined;
  }
}

/**
 * `file` with links and Windows short names (`RUNNER~1`) resolved, as the root and the working
 * folder are, so the three compare. As far as it exists: a file init is told about, such as a new
 * --lock, may not exist yet.
 */
function canonical(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

/** The repository's default branch, from the remote's HEAD; `main` when that isn't known. */
function defaultBranch(): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const branch = ref.replace(/^origin\//, "");
    if (branch) return scalar(branch);
  } catch {
    // No remote, or its HEAD isn't known locally.
  }
  return "main";
}

/**
 * The Action's `args`: the files init checked, and the options the lock records or the check
 * reads (--config, --adapter, --unmapped, --lock), so that the first pull request's check runs as
 * init's did. Paths are relative to the project's folder, with forward slashes, since the Action
 * runs on Linux; they can't contain spaces, since the Action splits `args` on them, or be outside
 * the repository, which the Action's checkout doesn't have.
 * @throws UsageError for a path or value the Action can't pass.
 */
export function workflowArgs(args: Args, target: WorkflowTarget): string {
  const file = (p: string) => {
    // A Windows-style path (`.\src\`) means the same folder wherever init runs: on Linux a
    // backslash is part of a name, so it's turned into a slash before the path is resolved.
    const absolute = canonical(path.resolve(target.cwd, p.replaceAll("\\", "/")));
    const fromRoot = path.relative(target.root, absolute);
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
      throw new UsageError(`${printable(p)} is outside the repository, so the GitHub Action's checkout won't have it. Move it into the repository.`);
    }
    const relative = path.relative(target.cwd, absolute).replaceAll("\\", "/") || ".";
    if (/\s/.test(relative)) {
      throw new UsageError(`The GitHub Action can't pass a path with spaces in it ("${printable(relative)}"). Rename it, or list the files in a tsconfig.json and use --project.`);
    }
    return checked(relative, "path");
  };
  if (args.unmapped !== undefined && !UNMAPPED_POLICIES.includes(args.unmapped as UnmappedPolicy)) throw new UsageError(`"unmapped" must be one of: ${UNMAPPED_POLICIES.join(", ")}.`);
  const words = [
    ...(args.project !== undefined ? ["--project", file(args.project)] : args.paths.map(file)),
    ...(args.config !== undefined ? ["--config", file(args.config)] : []),
    ...args.adapters.flatMap((a) => ["--adapter", file(a)]),
    ...(args.unmapped !== undefined ? ["--unmapped", args.unmapped] : []),
    ...(args.lock !== undefined ? ["--lock", file(args.lock)] : []),
  ];
  return words.join(" ");
}

/** A name or path for the workflow, which GitHub would otherwise read as an expression, or YAML as two lines. */
function checked(value: string, what: string): string {
  if (value.includes("${{")) throw new UsageError(`The GitHub Action can't be given a ${what} with \`\${{\` in it ("${printable(value)}"): GitHub reads it as an expression. Rename it.`);
  if (printable(value) !== value) throw new UsageError(`The GitHub Action can't be given a ${what} with a line break or control character in it ("${printable(value)}"). Rename it.`);
  return value;
}

/**
 * A YAML scalar for `value`: as it is when YAML reads that back as the same string, else in
 * double quotes. Unquoted, `@acme/api` doesn't parse, `#x` is a comment, `[a]` is a list, and
 * `1e3` is a number. JSON's escapes are YAML's too.
 */
function scalar(value: string): string {
  const plain = /^(--?)?[A-Za-z_][\w./-]*( [\w./-]+)*$/.test(value) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/**
 * How to install the project's dependencies in CI. PermLang reads code through the TypeScript
 * compiler: without the dependencies' types (`@types/node` above all), file, process, and
 * environment access are invisible. The package manager is the one whose lockfile is nearest,
 * from the project's folder up to the repository root, and it installs there: in a workspace,
 * at its root; in a project of its own in a subfolder, in that folder. With no lockfile, npm
 * installs where the nearest package.json is, else at the root. Install scripts are skipped;
 * they aren't needed for types.
 */
function installSteps(target: WorkflowTarget): string[] {
  const folders: string[] = [];
  for (let d = target.cwd; ; d = path.dirname(d)) {
    folders.push(d);
    if (path.relative(target.root, d) === "" || path.dirname(d) === d) break;
  }
  const where = (d: string) => {
    const relative = path.relative(target.root, d).replaceAll("\\", "/");
    return relative ? [`        working-directory: ${scalar(checked(relative, "folder"))}`] : [];
  };
  const run = (command: string, d: string) => [`      - run: ${command}`, ...where(d)];
  // pnpm and Yarn come through Corepack, which Node 25 and later no longer ship.
  const corepack = ["      - run: npm install --global corepack@latest", "      - run: corepack enable"];
  for (const d of folders) {
    const at = (file: string) => path.join(d, file);
    if (existsSync(at("pnpm-lock.yaml"))) return [...corepack, ...run("pnpm install --frozen-lockfile --ignore-scripts", d)];
    if (existsSync(at("yarn.lock"))) {
      // Yarn 2 and later (a .yarnrc.yml, or a lockfile with __metadata) skip install scripts with --mode=skip-build.
      const modern = existsSync(at(".yarnrc.yml")) || readFileSync(at("yarn.lock"), "utf8").includes("__metadata:");
      return [...corepack, ...run(modern ? "yarn install --immutable --mode=skip-build" : "yarn install --frozen-lockfile --ignore-scripts", d)];
    }
    if (existsSync(at("package-lock.json"))) return run("npm ci --ignore-scripts --no-audit --no-fund", d);
  }
  const nearest = folders.find((d) => existsSync(path.join(d, "package.json"))) ?? target.root;
  return run("npm install --ignore-scripts --no-audit --no-fund", nearest);
}

/** A workflow that runs the PermLang Action with these `args`. */
export function workflowFile(actionArgs: string, target: WorkflowTarget): string {
  const inputs = [
    ...(target.workingDirectory ? [`          working-directory: ${scalar(target.workingDirectory)}`] : []),
    ...(actionArgs ? [`          args: ${scalar(actionArgs)}`] : []),
  ];
  return [
    target.workingDirectory ? `name: ${scalar(`PermLang (${target.workingDirectory})`)}` : "name: PermLang",
    "",
    "on:",
    "  pull_request:",
    "  merge_group:",
    "  push:",
    `    branches: [${defaultBranch()}]`,
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
    ...installSteps(target),
    "      - uses: PermLang/permlang@v0",
    ...(inputs.length > 0 ? ["        with:", ...inputs] : []),
    "",
  ].join("\n");
}
