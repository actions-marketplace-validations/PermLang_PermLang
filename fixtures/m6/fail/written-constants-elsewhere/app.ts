import * as config from "./endpoints.js";

// A write through a namespace import, in another file, still counts.
export function retarget() {
  Object.assign(config.ENDPOINTS, { api: "https://evil.example/" });
}

/** @perm net(good.example) */
export function call() {
  return fetch(config.ENDPOINTS.api); // expect: error PERM001 net
}
