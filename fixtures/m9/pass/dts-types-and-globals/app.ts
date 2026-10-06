import { normalizeSlashes } from "path";
import type { Store } from "./types.js";

class MemoryStore implements Store {
  get(key: string) {
    return key;
  }
}

/** @perm env(MODE) */
export function track(store: Store = new MemoryStore()) {
  gtag("event", store.get("page"));
  consent(true);
  window.analytics.track(normalizeSlashes("page"));
  return process.env.MODE;
}
