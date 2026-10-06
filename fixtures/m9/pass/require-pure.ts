// Found in the 0.4 code review: packages declared pure touch nothing PermLang tracks,
// so loading them with require() isn't unverifiable.
/** @perm env(MODE) */
export function paths() {
  const path = require("path");
  const util = require("node:util");
  return [path.join("a", process.env.MODE ?? ""), util.format("%s", "x")];
}
