import { readFileSync, unlinkSync } from "node:fs";

const handlers: Record<string, () => unknown> = {
  ping: () => fetch("https://ping.example/"),
  noop: () => 1,
};

/** @perm env(MODE) */
export function run(kind: string) {
  return handlers[kind]!(); // expect: error PERM001 net(ping.example)
}

// Library functions stored in the record make it sensitive. Storing them is itself a use, and
// readFileSync could then be called with a writing flag.
const fsOps: Record<string, (path: string) => unknown> = {
  read: readFileSync, // expect: error PERM003 fs.read expect: error PERM003 fs.write
  remove: unlinkSync, // fs.write, reported once above
};

/** @perm env(MODE) */
export function op(kind: string, path: string) {
  return fsOps[kind]!(path); // expect: error PERM004 unverifiable
}

// A parameter's functions are unknown.
/** @perm env(MODE) */
export function viaParam(table: Record<string, () => unknown>, key: string) {
  return table[key]!(); // expect: error PERM004 unverifiable
}
