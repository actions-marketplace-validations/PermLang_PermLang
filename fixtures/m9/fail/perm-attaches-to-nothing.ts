// Found in the 0.4 code review: a @perm tag where no function can carry it was dropped
// without a word, so it looked like a check that wasn't there. It's now an error.
declare function wrap<T>(f: T): T;

/** @perm net(x.example) */ // expect: error PERM002 @perm
export const handler = wrap(async () => fetch("https://x.example/")); // expect: error PERM003 net(x.example)

export interface Sender {
  /** @perm net */ // expect: error PERM002 @perm
  send(u: string): void;
}

/** @perm net */ // expect: error PERM002 @perm
export class WithConstructor {
  constructor(readonly url: string) {}
}

export function inside() {
  /** @perm-unsafe reason:"not a function" */ // expect: error PERM002 @perm-unsafe
  return 1;
}
