// Found in the 0.4 code review: calls into the project's own JavaScript through a
// hand-written .d.ts reached nothing and gave no warning.
import { Legacy, helpers, run } from "./legacy.js";

/** @perm env(MODE) */
export function deploy(cmd: string) {
  run(cmd); // expect: error PERM004 unverifiable
  const legacy = new Legacy(cmd); // expect: error PERM004 unverifiable
  legacy.sync(); // expect: error PERM004 unverifiable
  helpers.purge(); // expect: error PERM004 unverifiable
  return [cmd].map(run); // expect: error PERM004 unverifiable
}
