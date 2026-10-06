// A .d.ts that only describes types: their implementations are TypeScript, found by
// dispatch. Ambient declarations (a script .d.ts, `declare global`, or augmenting a
// package with `declare module`) describe what the runtime or a package provides,
// like a package with no adapter, and aren't reported as the project's JavaScript.
export interface Store {
  get(key: string): string;
}
declare global {
  interface Window {
    analytics: { track(event: string): void };
  }
  function consent(granted: boolean): void;
}
declare module "path" {
  export function normalizeSlashes(p: string): string;
}
