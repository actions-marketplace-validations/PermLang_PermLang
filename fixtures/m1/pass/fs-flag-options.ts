import fs, { createReadStream, readFileSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { readFile, realpath } from "node:fs/promises";

declare const encoded: { encoding: BufferEncoding };

// Options that don't open the file for writing, and functions that only resolve a path.
/** @perm fs.read(./data) */
export async function reads() {
  readFileSync("./data/a.json", "utf8");
  readFileSync("./data/b.json", { encoding: "utf8", flag: "r" });
  readFileSync("./data/c.json", encoded);
  createReadStream("./data/d.log", { start: 10 });
  await readFile("./data/e.json", { encoding: "utf8" });
  realpathSync.native("./data/f");
  fs.realpath.native("./data/g", () => {});
  await realpath("./data/h");
  fs.realpathSync("./data/i");
}

// Writing to a descriptor such as stdout is not a file write.
/** @perm fs.read(./data) */
export function stdout() {
  new fs.Utf8Stream({ fd: 1 });
}

// A file opened for reading, read through its handle; an encoding instead of options.
/** @perm fs.read(./data) */
export async function moreReads(encoding: BufferEncoding) {
  fs.openSync("./data/j");
  readFileSync("./data/k", encoding);
  const handle = await fsp.open("./data/l");
  return handle.readFile();
}

// A project's own type that happens to be named FileHandle.
interface FileHandle {
  chmod(mode: number): Promise<void>;
}

export async function ownHandle(handle: FileHandle) {
  await handle.chmod(0o644);
}

// Each function reads only its own option name: a stream ignores `flag`, readFile ignores `flags`.
/** @perm fs.read(./data) */
export async function otherFlagNames() {
  // @ts-expect-error `flag` isn't a stream option
  createReadStream("./data/m.log", { flag: "w" });
  // @ts-expect-error `flags` isn't a readFile option
  await readFile("./data/n.json", { flags: "a" });
}
