// Found in the Ghostfolio trial: require() with a fixed specifier can be resolved like
// import. Only a capability-bearing module (child_process, fs, an adapter's package)
// makes it unverifiable, because the result is `any` and its calls can't be checked.
// JSON and packages declared pure are harmless. (A package with no adapter is listed
// and warned about, as an import of it would be: m9/fail/require-packages.ts.)

/** @perm env(MODE) */
export function loadData() {
  const countries = require("./countries.json");
  const schema = require("zod");
  return { countries, schema };
}
