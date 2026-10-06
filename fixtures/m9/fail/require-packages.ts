// Found in the 0.4 code review: require() returns `any`, so its calls go unchecked.
/** @perm env(MODE) */
export function legacy() {
  // A database client PermLang detects directly is as unverifiable as child_process.
  const pg = require("pg"); // expect: error PERM004 unverifiable
  // A package with no adapter is trusted and listed, as an import of it would be.
  const search = require("fuse.js"); // expect: warning PERM006 fuse.js
  return new pg.Pool().query("DELETE FROM users") && search;
}
