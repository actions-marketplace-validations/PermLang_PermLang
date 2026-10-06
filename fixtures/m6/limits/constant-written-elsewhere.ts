// limit: an `as const` object passed to a function that writes to it isn't followed, so its
// values are still trusted. Writes through the object itself, a cast, or Object.assign are caught
// (see fail/written-constants.ts).
const CONFIG = { url: "https://good.example/x" } as const;

function retarget(target: { url: string }) {
  target.url = "https://evil.example/x";
}

export function tamper() {
  retarget(CONFIG);
}

/** @perm net(good.example) */
export function use() {
  return fetch(CONFIG.url);
}
