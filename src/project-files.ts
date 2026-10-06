// Project configuration: GitHub workflows, Actions, and package.json scripts.
// These grant as much as code does (a token with write access, a secret, a hook that
// runs on install), and AI agents edit them as readily as code. Each file is recorded
// in the lock like a function, with what it grants as its capabilities:
//
//   ci.trigger(pull_request_target)   an event the workflow runs on
//   ci.permission(contents: write)    a token permission; ci.permission(default) when unset
//   ci.secret(NPM_TOKEN)              a secret the workflow reads; ci.secret(inherit), ci.secret(all)
//   ci.action(actions/checkout)       an Action, reusable workflow, or container image it runs
//   ci.unpinned(actions/setup-node)   ...referenced by a tag or branch, not an exact commit or digest
//   npm.script(postinstall: node x)   a package.json script and its command
//   ci.unverifiable(sha256:...)       a file, or part of one, PermLang can't read (npm.unverifiable
//                                     for package files), with the file's hash, so any edit shows
//
// So a change that adds any of these fails the check until the lock records it, and
// shows in the pull-request comment, exactly like new access in code. Version bumps of
// pinned Actions don't change the lock; switching one to a tag does.
//
// The files: .github/workflows/*.yml, action.yml at the root and under .github/actions,
// the action.yml of each local Action a step runs (`uses: ./path`), and package.json at
// the root and in each workspace package (see package-files.ts).
/**
 * @module
 * @perm fs.read
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import type { FunctionReport } from "./check.js";
import { EVERY_PACKAGE, MANIFESTS, readManifest, readPnpmWorkspace, workspaceFolders } from "./package-files.js";
import { readWorkflowFile, type LocalAction } from "./workflow-files.js";
import type { Position } from "./yaml-nodes.js";

/** Where a reader records what a file grants. */
export interface Sink {
  add(capability: string, text: string, at: Position): void;
  /** Something in the file (or the whole file) PermLang can't read. */
  unverifiable(text: string, at: Position): void;
}

// GitHub's own names are lower case; other cases are read too, since a runner on a
// case-insensitive file system finds them, and reading a file that never runs is harmless.
const YAML = /\.ya?ml$/i;
const ACTION = /^action\.ya?ml$/i;
const DOCKERFILE = /^dockerfile$/i;

/** Every configuration file under `root` that PermLang records, as lock entries. */
export function projectFiles(root: string): FunctionReport[] {
  const project = new Project(root);
  for (const file of listFiles(path.join(root, ".github", "workflows"), false, YAML)) project.yaml(file, "workflow");
  for (const file of listFiles(root, false, ACTION)) project.yaml(file, "action");
  for (const file of listFiles(path.join(root, ".github", "actions"), true, ACTION)) project.yaml(file, "action");
  project.packages();
  return project.reports();
}

class Project {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly root: string) {}

  /** A workflow or Action file, then each local Action its steps run. */
  yaml(file: string, kind: "workflow" | "action") {
    const entry = this.open(file, "ci");
    if (entry?.text === undefined) return;
    for (const local of readWorkflowFile(entry.text, kind, entry)) this.follow(local, entry);
  }

  /** package.json (and pnpm's other manifests) at the root and in every workspace package. */
  packages() {
    const patterns = this.manifests(this.root);
    const pnpm = path.join(this.root, "pnpm-workspace.yaml");
    if (exists(pnpm)) {
      // Nothing else opens it, so it's new here. One that can't be read at all is unverifiable,
      // and every package's scripts are recorded, as for one that doesn't parse.
      const entry = this.open(pnpm, "npm")!;
      patterns.push(...(entry.text === undefined ? EVERY_PACKAGE : readPnpmWorkspace(entry.text, entry)));
    }
    for (const dir of workspaceFolders(this.root, patterns)) this.manifests(dir);
  }

  reports(): FunctionReport[] {
    return [...this.entries.values()]
      .map((e) => e.report())
      .filter((e) => e.actual.length > 0)
      .sort((a, b) => (a.file < b.file ? -1 : 1)); // each file has one entry
  }

  /**
   * A step's `uses: ./path` runs the action.yml in that folder, read like any other. When
   * the repository doesn't have one (an earlier step checks it out, say, or it's outside
   * the repository), what runs can change without a change here: it's unpinned. A folder
   * with only a Dockerfile is an Action GitHub builds from the repository.
   */
  private follow(local: LocalAction, from: Entry) {
    const dir = path.resolve(this.root, local.ref.replace(/^\$\//, "").replaceAll("\\", "/"));
    const relative = path.relative(this.root, dir);
    const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    const actions = inside ? localFiles(dir, ACTION) : [];
    for (const file of actions) this.yaml(file, "action");
    if (actions.length === 0 && !(inside && localFiles(dir, DOCKERFILE).length > 0)) {
      from.add(`ci.unpinned(${local.ref})`, `uses: ${local.ref}, which isn't in the repository`, local.at);
    }
  }

  /** Records a folder's manifests, and returns the workspace patterns its package.json lists. */
  private manifests(dir: string): string[] {
    const patterns: string[] = [];
    for (const name of MANIFESTS) {
      const file = path.join(dir, name);
      if (!exists(file)) continue;
      const entry = this.open(file, "npm");
      if (entry?.text !== undefined) patterns.push(...readManifest(name, entry.text, entry));
    }
    return patterns;
  }

  /** A new entry for `file`, or undefined when it's already recorded. */
  private open(file: string, kind: "ci" | "npm"): Entry | undefined {
    const resolved = path.resolve(file);
    if (this.entries.has(resolved)) return undefined;
    const entry = new Entry(resolved, kind);
    this.entries.set(resolved, entry);
    return entry;
  }
}

class Entry implements Sink {
  readonly caps = new Map<string, { text: string; at: Position }>();
  /** The file's contents; undefined when it can't be read, which is recorded instead. */
  readonly text: string | undefined;
  /** What `unverifiable` hashes: the contents, or for a link that leads nowhere, where it leads. */
  private readonly fingerprint: string;

  constructor(
    readonly file: string,
    private readonly kind: "ci" | "npm",
  ) {
    try {
      this.text = readFileSync(file, "utf8");
      this.fingerprint = this.text;
    } catch (e) {
      const target = linkTarget(file);
      this.fingerprint = target ?? String((e as NodeJS.ErrnoException).code);
      this.unverifiable(target === undefined ? "a file PermLang can't read" : `a link to ${target}, which PermLang can't read`, { line: 1, column: 1 });
    }
  }

  add(capability: string, text: string, at: Position) {
    if (!this.caps.has(capability)) this.caps.set(capability, { text, at });
  }

  /**
   * Recorded with the file's SHA-256, so editing a file PermLang can't read still changes
   * the lock. Line endings and a byte-order mark don't count: Git changes those on checkout.
   */
  unverifiable(text: string, at: Position) {
    const normalized = this.fingerprint.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    this.add(`${this.kind}.unverifiable(sha256:${createHash("sha256").update(normalized).digest("hex")})`, text, at);
  }

  report(): FunctionReport {
    const actual = [...this.caps.keys()].sort();
    return {
      file: this.file,
      name: `<${path.basename(this.file)}>`,
      line: 1,
      annotated: false,
      declared: [],
      actual,
      via: Object.fromEntries(actual.map((c) => [c, [this.caps.get(c)!.text]])),
      sites: Object.fromEntries(actual.map((c) => [c, this.caps.get(c)!.at])),
      kind: "config",
    };
  }
}

/**
 * Files in `dir` whose names match, sorted. A link that leads nowhere is included, to be
 * recorded as unverifiable rather than skipped. Recursive listings follow folder links,
 * as a runner does, but visit each folder once, so a link that loops back ends. A folder
 * that isn't there has no files; one that can't be listed stops the check.
 */
function listFiles(dir: string, recursive: boolean, match: RegExp, seen = new Set<string>()): string[] {
  let entries: Dirent[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    const real = realpathSync(dir);
    if (seen.has(real)) return [];
    seen.add(real);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (match.test(entry.name) && isFileOrBroken(file)) out.push(file);
    else if (recursive && (entry.isDirectory() || entry.isSymbolicLink())) out.push(...listFiles(file, true, match, seen));
  }
  return out.sort();
}

/**
 * A local Action's files. The path comes from the workflow, so it can be one no folder
 * can have (a NUL character, say): then it has none, and the reference is unpinned.
 */
function localFiles(dir: string, match: RegExp): string[] {
  try {
    return listFiles(dir, false, match);
  } catch {
    return [];
  }
}

function isFileOrBroken(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return true;
  }
}

/** Whether there's anything at `file`, a link that leads nowhere included. */
function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function linkTarget(file: string): string | undefined {
  try {
    return readlinkSync(file);
  } catch {
    return undefined;
  }
}
