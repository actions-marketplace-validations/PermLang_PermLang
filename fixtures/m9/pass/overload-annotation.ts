// An overloaded function's @perm can sit on any of its signatures.
/** @perm net(store.example) */
export function load(id: number): Promise<Response>;
export function load(name: string): Promise<Response>;
export function load(key: number | string) {
  return fetch(`https://store.example/items/${key}`);
}
