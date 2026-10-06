// Type-only imports and namespace aliases load nothing when the code runs, even from a URL.
import type { Payload } from "data:text/javascript,export {}";
import type Remote = require("https://types.example/remote.js");

namespace Shapes {
  export const circle = 1;
}
import circle = Shapes.circle;

export type { Payload, Remote };
export { circle };
