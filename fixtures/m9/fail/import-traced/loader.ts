// Found in the 0.4 code review: import() with a specifier that isn't written as a
// literal (a const, an `as const` property, an enum member) gives `any`, so nothing
// called on what it loads resolves. The specifier is traced instead.
const PLUGIN = "./plugin.js";
const MODULES = { cp: "node:child_process" } as const;
enum Builtin {
  Fs = "node:fs",
}

/** @perm env(MODE) */
export async function loadPlugin() {
  // A project file: its top-level code runs, and any of its exports can be called.
  const m = await import(PLUGIN); // expect: error PERM001 net(plugin-load.example) // expect: error PERM001 net(plugin.example)
  return m.start(process.env.MODE);
}

/** @perm env(MODE) */
export async function loadBuiltins() {
  // A module whose functions carry capabilities can't be followed through `any`.
  const cp = await import(MODULES.cp); // expect: error PERM004 unverifiable
  const fs = await import(Builtin.Fs); // expect: error PERM004 unverifiable
  cp.execSync("id");
  fs.writeFileSync("/etc/x", "y");
}
