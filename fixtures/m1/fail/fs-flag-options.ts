import fs, { createReadStream, readFileSync } from "node:fs";
import { open as openFile, readFile } from "node:fs/promises";

declare const options: { encoding?: BufferEncoding; flag?: string };
declare const mode: string;

// Found in the 0.3 review: a read function's `flag` option can truncate or append to the file.
/** @perm fs.read(./data) */
export async function flags() {
  readFileSync("./data/a.json", { flag: "w" }); // expect: error PERM001 fs.write(./data/a.json)
  readFileSync("./data/b.json", { encoding: "utf8", flag: "a+" }); // expect: error PERM001 fs.write(./data/b.json)
  createReadStream("./data/c.log", { flags: "w" }); // expect: error PERM001 fs.write(./data/c.log)
  await readFile("./data/d.json", { flag: "r+" }); // expect: error PERM001 fs.write(./data/d.json)
  fs.readFileSync("./data/e.json", options); // expect: error PERM001 fs.write(./data/e.json)
  fs.readFileSync("./data/f.json", { flag: mode }); // expect: error PERM001 fs.write(./data/f.json)
  fs.readFileSync("./data/g.json", { ...options, encoding: "utf8" }); // expect: error PERM001 fs.write(./data/g.json)
}

// Streams and descriptors that write without a write function.
/** @perm fs.read(./data) */
export function streams(fd: number) {
  new fs.Utf8Stream({ dest: "./logs/app.log" }); // expect: error PERM001 fs.write(./logs/app.log)
  new (fs.WriteStream as any)("./out.txt"); // expect: error PERM001 fs.write
  Reflect.construct(fs.WriteStream, ["./out.txt"]); // expect: error PERM001 fs.write
  fs.fchmodSync(fd, 0o777); // expect: error PERM001 fs.write
}

// A read function used as a value can be called with any flags, as open() can.
/** @perm fs.read */
export function asValue() {
  return [readFileSync].map((f) => f); // expect: error PERM001 fs.write
}

// Subclasses of fs's streams, options that can't be read, and a FileHandle's metadata.
class LogStream extends fs.WriteStream {}

/** @perm fs.read(./data) */
export async function more(raw: string, logPath: string, options: { dest: string }) {
  readFileSync("./data/h.json", JSON.parse(raw)); // expect: error PERM001 fs.write(./data/h.json)
  new LogStream(); // expect: error PERM001 fs.write
  Reflect.construct(LogStream, ["./logs/y.log"]); // expect: error PERM001 fs.write
  new fs.Utf8Stream({ dest: logPath }); // expect: error PERM001 fs.write
  new fs.Utf8Stream(options); // expect: error PERM001 fs.write
  new fs.Utf8Stream({ ...options, sync: true }); // expect: error PERM001 fs.write
  Reflect.construct(fs.Utf8Stream, [{ dest: "./logs/z.log" }]); // expect: error PERM001 fs.write
  const handle = await openFile("./data/i.json", "r");
  await handle.chmod(0o777); // expect: error PERM001 fs.write
}
