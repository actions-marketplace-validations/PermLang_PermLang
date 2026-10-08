// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

/**
 * Brings the packages another job installed into this checkout, for the check to read, and
 * nothing else. Installing can run code the pull request controls, even with install scripts
 * off (a package manager's settings and plugins can), so the workflow `permlang init --workflow`
 * writes installs in a job of its own, which packs every `node_modules` folder into a tar
 * archive. That job may have been made to pack anything, so here the archive is unpacked into
 * an empty folder and read entry by entry, without following links, before anything moves:
 *
 * - every entry is inside a `node_modules` folder, or a generated folder the workflow names;
 * - a link points inside the repository, outside `.git`, by a relative path;
 * - each folder is new to the checkout, in a folder that's no link: the checkout's files, which
 *   the check reads as the pull request's code, are never changed or added to.
 *
 * Anything else fails the import, and nothing is moved.
 * @module
 * @perm fs.read, fs.write, exec
 */

import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { printable } from "./report.js";

/** Why an archive of dependencies wasn't imported. */
export class DependencyImportError extends Error {}

export interface ImportOptions {
  /** The tar archive the installing job made, of paths from the repository root. */
  archive: string;
  /** The repository root: the checkout the check reads. */
  root: string;
  /** Where to unpack the archive first: an empty folder is made in it. */
  temp: string;
  /** Folders, from the repository root, that the installing job generated (`prisma generate`, say). */
  generated?: readonly string[];
}

/**
 * What the Action runs (dist/import-dependencies.js), in the repository root:
 * `<folder with the archive> <temp folder> [generated folder]...`. The folder is where
 * download-artifact put the installing job's artifact, which must hold exactly one .tar file.
 * Returns the exit code: 0 imported, 1 refused, 2 used wrongly.
 */
export function importCommand(argv: readonly string[]): number {
  const [folder, temp, ...generated] = argv;
  if (folder === undefined || temp === undefined) {
    console.error("Usage: import-dependencies <folder with the archive> <temp folder> [generated folder]...");
    return 2;
  }
  try {
    const archives = readdirSync(folder).filter((f) => f.endsWith(".tar"));
    if (archives.length !== 1) throw new DependencyImportError(`Expected one .tar archive of dependencies in ${printable(folder)}, and found ${archives.length}.`);
    const moved = importDependencies({ archive: path.join(folder, archives[0]!), root: process.cwd(), temp, generated });
    console.log(moved.length > 0 ? `Imported ${moved.map(printable).join(", ")}.` : "The archive of dependencies has no node_modules folder, so nothing was imported.");
    return 0;
  } catch (e) {
    if (!(e instanceof DependencyImportError)) throw e;
    console.error(`Couldn't import the dependencies. ${e.message}`);
    return 1;
  }
}

/**
 * Unpacks the archive, checks every entry, and moves each `node_modules` folder and generated
 * folder into place. Returns the folders it moved, from the repository root.
 * @throws DependencyImportError when the archive has anything else, or would change the checkout.
 */
export function importDependencies(options: ImportOptions): string[] {
  // The tar on Windows runners (Git's) unpacks a link as a copy of whatever it points to.
  if (process.platform === "win32") throw new DependencyImportError("Importing dependencies works on Linux and macOS runners, not Windows. Run the check on ubuntu-latest.");
  const staging = mkdtempSync(path.join(options.temp, "permlang-dependencies-"));
  try {
    unpack(options.archive, staging);
    return importUnpacked(staging, options.root, options.generated ?? []);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Checks every entry of an unpacked archive, then moves each `node_modules` folder and generated
 * folder into the checkout at `root`, or nothing when any check fails.
 * @throws DependencyImportError as importDependencies does.
 */
export function importUnpacked(staging: string, root: string, generated: readonly string[]): string[] {
  const named = generated.map(generatedFolder);
  const checkout = realpathSync.native(root);
  const folders = foldersIn(staging, named);
  for (const folder of folders) checkDestination(checkout, folder);
  for (const folder of folders) move(path.join(staging, ...folder.split("/")), path.join(checkout, ...folder.split("/")));
  return folders;
}

/** A generated folder as the workflow names it: a plain path inside the repository. */
function generatedFolder(folder: string): string {
  const normal = path.posix.normalize(folder.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (normal === "." || normal.startsWith("../") || normal === ".." || path.posix.isAbsolute(normal) || /^[a-z]:/i.test(normal) || normal.split("/").includes(".git")) {
    throw new DependencyImportError(`"${printable(folder)}" isn't a folder inside the repository, so it can't be a generated folder.`);
  }
  return normal;
}

/**
 * tar refuses entries with absolute paths or `..` (GNU tar skips them and exits 2; bsdtar
 * refuses them), and never writes through a link it made. Either way, a non-zero exit fails.
 */
function unpack(archive: string, into: string): void {
  try {
    execFileSync("tar", ["-xf", path.resolve(archive), "-C", into, "--no-same-owner"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const { stderr } = e as { stderr?: unknown };
    const first = (typeof stderr === "string" ? stderr : "").trim().split("\n")[0] ?? "";
    throw new DependencyImportError(`The archive of dependencies couldn't be unpacked${first ? `: ${printable(first)}` : "."}`);
  }
}

/**
 * The folders to move, from the root: each outermost `node_modules` folder, and each generated
 * folder in the archive. Every entry is checked, without following links.
 * @throws DependencyImportError for any entry outside them, a link out of the repository or
 *   into `.git`, or anything that isn't a file, a folder, or a link.
 */
function foldersIn(staging: string, generated: readonly string[]): string[] {
  const folders = new Set<string>();
  const pending = [""];
  for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
    for (const name of readdirSync(path.join(staging, ...rel.split("/").filter(Boolean)))) {
      const entry = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path.join(staging, ...entry.split("/")));
      const parts = entry.split("/");
      if (parts.includes(".git")) throw new DependencyImportError(`The archive of dependencies has ${printable(entry)}, in a .git folder.`);
      const modules = parts.indexOf("node_modules");
      const folder = modules >= 0 ? parts.slice(0, modules + 1).join("/") : generated.find((g) => entry === g || entry.startsWith(`${g}/`));
      if (folder === undefined) {
        // Outside every folder that's moved, only the folders that lead to one can be.
        if (!stat.isDirectory()) throw new DependencyImportError(`The archive of dependencies has ${printable(entry)}, which isn't in a node_modules folder${generated.length > 0 ? " or a generated one" : ""}.`);
        pending.push(entry);
        continue;
      }
      if (entry === folder && !stat.isDirectory()) throw new DependencyImportError(`The archive of dependencies has ${printable(entry)} as something other than a folder.`);
      if (stat.isSymbolicLink()) checkLink(entry, readlinkSync(path.join(staging, ...entry.split("/"))));
      else if (stat.isDirectory()) pending.push(entry);
      else if (!stat.isFile()) throw new DependencyImportError(`The archive of dependencies has ${printable(entry)}, which is neither a file, a folder, nor a link.`);
      if (entry === folder) folders.add(folder);
    }
  }
  return [...folders].sort();
}

/**
 * A link may point anywhere in the repository (a workspace package links to its folder, and pnpm
 * links between node_modules folders), but only by a relative path, and not into `.git`.
 */
function checkLink(entry: string, target: string): void {
  const posix = target.replaceAll("\\", "/");
  if (path.posix.isAbsolute(posix) || /^[a-z]:/i.test(posix)) throw new DependencyImportError(`The archive of dependencies has a link, ${printable(entry)}, to an absolute path (${printable(target)}).`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), posix));
  if (resolved === ".." || resolved.startsWith("../")) throw new DependencyImportError(`The archive of dependencies has a link, ${printable(entry)}, to ${printable(target)}, outside the repository.`);
  if (resolved.split("/").includes(".git")) throw new DependencyImportError(`The archive of dependencies has a link, ${printable(entry)}, into a .git folder.`);
}

/**
 * A folder can only be added: it mustn't be in the checkout already (a committed node_modules, or
 * a generated folder that's tracked), and the folder it goes in must be the checkout's own, with
 * no link on the way that would put it somewhere else.
 */
function checkDestination(root: string, folder: string): void {
  const destination = path.join(root, ...folder.split("/"));
  const parent = path.dirname(destination);
  let real: string;
  try {
    real = realpathSync.native(parent);
  } catch {
    throw new DependencyImportError(`Can't add ${printable(folder)}: ${printable(path.posix.dirname(folder))} isn't in the checkout.`);
  }
  if (path.relative(parent, real) !== "" || !lstatSync(parent).isDirectory()) {
    throw new DependencyImportError(`Can't add ${printable(folder)}: the way to it in the checkout goes through a link.`);
  }
  let exists = true;
  try {
    lstatSync(destination);
  } catch {
    exists = false;
  }
  if (exists) throw new DependencyImportError(`Can't add ${printable(folder)}: the checkout has it already.`);
}

/** Moves a folder, or copies it (links as they are) when it's on another drive. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
}
