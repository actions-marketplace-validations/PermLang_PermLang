// Node's fs and fs/promises, classified into reads and writes with literal paths.
// This stays custom code rather than an adapter manifest: open() depends on its
// flags, readFile() on its `flag` option, and copies read one path and write another.

import { Node, type Type } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString, propertyValue } from "./shared.js";

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

// Classes whose constructors open a file: what each is classified as. ReadStream and
// WriteStream declare no constructor of their own, so they're matched by the class.
const STREAM_CLASSES = new Map<string | undefined, string>([["ReadStream", "createReadStream"], ["WriteStream", "createWriteStream"], ["Utf8Stream", "Utf8Stream"]]);

/** The fs function a declaration is, or undefined. */
export function fsFunctionName(declaration: Node): string | undefined {
  if (Node.isClassDeclaration(declaration) || Node.isConstructorDeclaration(declaration)) {
    const owner = Node.isClassDeclaration(declaration) ? declaration : declaration.getParent();
    return Node.isClassDeclaration(owner) && isInFsModule(owner) ? STREAM_CLASSES.get(owner.getName()) : undefined;
  }
  if (Node.isMethodSignature(declaration)) return fileHandleMethod(declaration);
  if (!Node.isFunctionDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return undefined;
  if (!isInFsModule(declaration)) return undefined;
  // `realpathSync.native()` and `readFile.__promisify__()` are declared in a namespace named after the function.
  const namespace = declaration.getParent()?.getParent();
  if (Node.isModuleDeclaration(namespace) && !Node.isStringLiteral(namespace.getNameNode())) return namespace.getName();
  return declaration.getName();
}

/**
 * The fs class an instance type is (`new fs.WriteStream(path)`), or extends when `direct` is
 * false, as fsFunctionName names it.
 */
export function fsStreamClass(type: Type, direct = true): { name: string; direct: boolean } | undefined {
  for (const declaration of type.getSymbol()?.getDeclarations() ?? []) {
    const name = fsFunctionName(declaration);
    if (name !== undefined) return { name, direct };
  }
  // Class hierarchies can't be circular, so this ends.
  for (const base of type.getBaseTypes()) {
    const found = fsStreamClass(base, false);
    if (found) return found;
  }
  return undefined;
}

/**
 * A function exported by an fs module itself. Members of the objects fs returns
 * (`Stats.isDirectory`, `FileHandle.read`, streams) are excluded: they act on
 * something already opened or read, where the access was checked.
 */
function isInFsModule(declaration: Node): boolean {
  for (const a of declaration.getAncestors()) {
    if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isTypeLiteral(a)) return false;
    if (Node.isModuleDeclaration(a) && FS_MODULES.has(a.getName().replace(/^["']|["']$/g, ""))) return true;
  }
  return false;
}

// FileHandle methods that change a file's metadata, which works whatever it was opened for.
const FILE_HANDLE_METADATA = new Map([["chmod", "fchmod"], ["chown", "fchown"], ["utimes", "futimes"]]);

function fileHandleMethod(declaration: Node & { getName(): string }): string | undefined {
  const owner = declaration.getParent();
  if (!Node.isInterfaceDeclaration(owner) || owner.getName() !== "FileHandle") return undefined;
  const inFs = owner.getAncestors().some((a) => Node.isModuleDeclaration(a) && FS_MODULES.has(a.getName().replace(/^["']|["']$/g, "")));
  return inFs ? FILE_HANDLE_METADATA.get(declaration.getName()) : undefined;
}

// Operations on an open descriptor add no access; it was granted at open(). Writing to one opened
// only for reading fails.
const FD_ONLY = new Set([
  "close", "fsync", "fdatasync", "fstat", "read", "readv", "write", "writev", "ftruncate",
]);
// Changing a file's mode, owner, or times through a descriptor works however it was opened, so
// it writes the file, whose path isn't known here.
const FD_METADATA = new Set(["fchmod", "fchown", "futimes"]);
const READS = new Set([
  "readdir", "stat", "lstat", "statfs", "exists", "access",
  "watch", "watchFile", "unwatchFile", "realpath", "readlink", "opendir", "glob", "openAsBlob",
]);
// Reads, unless the option that sets the flags (readFile's `flag`, createReadStream's and
// ReadStream's `flags`; Node ignores the other name) opens the file for writing.
const FLAGGED_READS = new Map([["readFile", "flag"], ["createReadStream", "flags"]]);
// Source is read, destination is written.
const COPIES = new Set(["copyFile", "cp"]);
// Every path argument is written.
const TWO_PATH_WRITES = new Set(["rename", "link", "symlink"]);

/** What calling fs function `fn` with `args` touches. No args (used as a value) makes every path dynamic. */
export function fsCapabilities(fn: string, args: readonly Node[]): Capability[] {
  const base = fn.replace(/Sync$/, "");
  const scoped = (name: string, i: number): Capability => {
    const path = literalString(args[i]);
    return path === undefined ? { name, dynamic: true } : { name, arg: path };
  };
  const read = (i: number) => scoped("fs.read", i);
  const write = (i: number) => scoped("fs.write", i);

  if (FD_ONLY.has(base)) return [];
  if (FD_METADATA.has(base)) return [{ name: "fs.write", dynamic: true }];
  if (READS.has(base)) return [read(0)];
  // Used as a value, it could be called with any flags.
  const flagOption = FLAGGED_READS.get(base);
  if (flagOption) return flagCapabilities(args.length === 0 ? undefined : optionFlags(args[1], flagOption), read(0), write(0));
  if (base === "Utf8Stream") return utf8StreamCapabilities(args[0]);
  if (COPIES.has(base)) return [read(0), write(1)];
  if (TWO_PATH_WRITES.has(base)) return [write(0), write(1)];
  if (base === "open") return openCapabilities(args, read(0), write(0));
  // Everything else (writeFile, mkdir, rm, unlink, chmod, and anything unrecognized)
  // is treated as a write, so an unknown fs function never passes silently.
  return [write(0)];
}

function openCapabilities(args: readonly Node[], read: Capability, write: Capability): Capability[] {
  // Used as a value, open() could be called with any flags.
  if (args.length === 0) return [read, write];
  const flags = args[1];
  return flagCapabilities(flags ? literalString(flags) : "r", read, write);
}

/** What opening a file with `flags` allows; undefined flags could be anything. */
function flagCapabilities(flags: string | undefined, read: Capability, write: Capability): Capability[] {
  if (flags === undefined) return [read, write];
  const caps: Capability[] = [];
  if (flags.includes("r") || flags.includes("+")) caps.push(read);
  if (/[wax+]/.test(flags)) caps.push(write);
  return caps.length > 0 ? caps : [read, write];
}

/**
 * The flags an options argument opens a file with, read from `name`: readFile's `flag`, or a
 * stream's `flags` (Node reads only that one, and ignores the other). "r" when it can't set it
 * (an encoding string, or a type without it); undefined when it can't be known.
 */
function optionFlags(options: Node | undefined, name: string): string | undefined {
  if (!options) return "r";
  if (Node.isObjectLiteralExpression(options)) {
    const value = propertyValue(options, name);
    if (value === "unknown") return undefined;
    return value === "absent" ? "r" : literalString(value);
  }
  const type = options.getType();
  if (type.isAny() || type.isUnknown()) return undefined;
  const mayHaveFlags = (t: Type) => t.getProperty(name) !== undefined || t.getStringIndexType() !== undefined;
  return (type.isUnion() ? type.getUnionTypes() : [type]).some(mayHaveFlags) ? undefined : "r";
}

/** `new fs.Utf8Stream({ dest })` writes `dest`; with only an `fd` (such as stdout), it writes to what's already open. */
function utf8StreamCapabilities(options: Node | undefined): Capability[] {
  if (options && Node.isObjectLiteralExpression(options)) {
    const dest = propertyValue(options, "dest");
    if (dest === "absent" && propertyValue(options, "fd") !== "absent") return [];
    const path = dest === "absent" || dest === "unknown" ? undefined : literalString(dest);
    if (path !== undefined) return [{ name: "fs.write", arg: path }];
  }
  return [{ name: "fs.write", dynamic: true }];
}
