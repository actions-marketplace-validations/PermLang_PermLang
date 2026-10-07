// Found in the re-verification: writing functions reached other ways than `Object.assign(X, ...)`,
// a fixed object whose own method writes to it, and a namespace whose exported constant is a
// property of the namespace object.
const BRACKET = { url: "https://good.example/x" } as const;
const DESTRUCTURED = { url: "https://good.example/x" } as const;
const CALLED = { url: "https://good.example/x" } as const;
const APPLIED = { url: "https://good.example/x" } as const;
const GLOBAL = { url: "https://good.example/x" } as const;
const SPREAD = { url: "https://good.example/x" } as const;
const REFLECTED = { url: "https://good.example/x" } as const;
const SELF = {
  url: "https://good.example/x",
  set(u: string) {
    (this as { url: string }).url = u;
  },
} as const;
enum Defined {
  Url = "https://good.example/x",
}
namespace Endpoints {
  export const collect = "https://good.example/collect";
}

export function tamper() {
  Object["assign"](BRACKET, { url: "https://evil.example/x" });
  const { assign } = Object;
  assign(DESTRUCTURED, { url: "https://evil.example/x" });
  Object.assign.call(null, CALLED, { url: "https://evil.example/x" });
  Object.assign.apply(null, [APPLIED, { url: "https://evil.example/x" }]);
  globalThis.Object.assign(GLOBAL, { url: "https://evil.example/x" });
  Object.assign(...([SPREAD, { url: "https://evil.example/x" }] as [object, object]));
  Reflect.apply(Object.assign, null, [REFLECTED, { url: "https://evil.example/x" }]);
  SELF.set("https://evil.example/x");
  const { defineProperty } = Reflect;
  defineProperty(Defined, "Url", { value: "https://evil.example/x" });
  Object.assign(Endpoints, { collect: "https://evil.example/collect" });
}

/** @perm net(good.example) */
export function use() {
  void fetch(BRACKET.url); // expect: error PERM001 net
  void fetch(DESTRUCTURED.url); // expect: error PERM001 net
  void fetch(CALLED.url); // expect: error PERM001 net
  void fetch(APPLIED.url); // expect: error PERM001 net
  void fetch(GLOBAL.url); // expect: error PERM001 net
  void fetch(SPREAD.url); // expect: error PERM001 net
  void fetch(REFLECTED.url); // expect: error PERM001 net
  void fetch(SELF.url); // expect: error PERM001 net
  void fetch(Defined.Url); // expect: error PERM001 net
  void fetch(Endpoints.collect); // expect: error PERM001 net
}

// More of the same: bind, positions a spread hides, and functions of the object's own that
// aren't plain methods (an accessor, a `function` property, a method of an object nested in it).
const BOUND = { url: "https://good.example/x" } as const;
const CALLED_AFTER_SPREAD = { url: "https://good.example/x" } as const;
const AFTER_SPREAD = { url: "https://good.example/x" } as const;
const IN_SPREAD = { url: "https://good.example/x" } as const;
const ACCESSOR = {
  url: "https://good.example/x",
  get reset() {
    (this as { url: string }).url = "https://evil.example/x";
    return true;
  },
} as const;
const PROPERTY = {
  url: "https://good.example/x",
  set: function (u: string) {
    (this as { url: string }).url = u;
  },
} as const;
const NESTED = {
  api: {
    url: "https://good.example/x",
    set(u: string) {
      (this as { url: string }).url = u;
    },
  },
} as const;

export function tamperMore(sources: object[]) {
  Object.assign.bind(null, BOUND)({ url: "https://evil.example/x" });
  Object.assign.call(null, ...sources, CALLED_AFTER_SPREAD);
  Object.assign(...(sources as [object]), AFTER_SPREAD);
  Object.assign(...([...sources, IN_SPREAD] as [object]));
  void ACCESSOR.reset;
  PROPERTY.set("https://evil.example/x");
  NESTED.api.set("https://evil.example/x");
}

/** @perm net(good.example) */
export function useMore() {
  void fetch(BOUND.url); // expect: error PERM001 net
  void fetch(CALLED_AFTER_SPREAD.url); // expect: error PERM001 net
  void fetch(AFTER_SPREAD.url); // expect: error PERM001 net
  void fetch(IN_SPREAD.url); // expect: error PERM001 net
  void fetch(ACCESSOR.url); // expect: error PERM001 net
  void fetch(PROPERTY.url); // expect: error PERM001 net
  void fetch(NESTED.api.url); // expect: error PERM001 net
}
