// A literal module name is like importing it: what's called on the result is checked.
/** @perm fs.read(./data) */
export function builtins() {
  const path = process.getBuiltinModule("node:path");
  const fs = process.getBuiltinModule("node:fs");
  return [path.join("a", "b"), fs.readFileSync("./data/x.json", "utf8")];
}

// Reading the process's own state touches nothing.
/** @perm fs.read(./data) */
export function state() {
  return [process.cwd(), process.pid, process.uptime(), process.memoryUsage().rss];
}
