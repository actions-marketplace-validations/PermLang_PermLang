// Found in the 0.4 code review: `import x = require()` runs the module's top-level
// code like any other import.
import evil = require("./evil.js"); // expect: error PERM003 exec

/** @perm env(MODE) */
export function t() {
  return evil.ready;
}
