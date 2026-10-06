import { writeFileSync } from "node:fs";

// Reading, copying, spreading, or freezing an `as const` object or enum doesn't change it.
const CONFIG = { url: "https://good.example/x", nested: { path: "./public/a.txt" } } as const;
enum Endpoint {
  Url = "https://good.example/x",
}

export function harmless() {
  const copy = Object.assign({}, CONFIG, { extra: 1 });
  const spread = { ...CONFIG, url: "https://other.example/" };
  Object.freeze(CONFIG);
  return [Object.keys(CONFIG), copy, spread, CONFIG.url.length, Endpoint.Url.toUpperCase(), CONFIG satisfies object];
}

/** @perm net(good.example), fs.write(./public) */
export function use() {
  void fetch(CONFIG.url);
  void fetch(Endpoint.Url);
  writeFileSync(CONFIG.nested.path, "x");
}
