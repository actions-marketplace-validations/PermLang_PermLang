// Fixed values given to writing functions as a source rather than the target, a function of the
// project's own that happens to be named `assign`, a method that only reads its object, and a
// namespace that's only read.
const SOURCE = { url: "https://good.example/x" } as const;
const READER = {
  url: "https://good.example/x",
  get() {
    return this.url;
  },
} as const;
namespace Api {
  export const url = "https://good.example/x";
}

function assign(target: object, source: object) {
  return { ...target, ...source };
}

export function copy() {
  return [
    Object.assign({}, SOURCE),
    Object.assign.call(null, {}, SOURCE),
    Reflect.apply(Object.assign, null, [{}, SOURCE]),
    assign(SOURCE, {}),
    Object.freeze(SOURCE),
    Object.keys(Api),
    READER.get(),
  ];
}

/** @perm net(good.example) */
export function use() {
  return [fetch(SOURCE.url), fetch(READER.url), fetch(Api.url)];
}

// `this` that isn't the fixed object's: a class's, a function declared inside, a callback's, and
// an arrow's at the top of the module. And `apply` given the object as a source.
const SCOPED = {
  url: "https://good.example/x",
  Model: class {
    url = "";
    set(u: string) {
      this.url = u;
    },
  },
  make() {
    function local(this: { url: string }) {
      this.url = "https://evil.example/x";
    }
    [1].forEach(function (this: { url: string }) {
      this.url = "https://evil.example/x";
    }, { url: "" });
    return local;
  },
  outer: () => {
    (this as unknown as { url: string }).url = "https://evil.example/x";
  },
} as const;

export function copyMore() {
  return [Object.assign.apply(null, [{}, SOURCE]), SCOPED.make(), SCOPED.outer()];
}

/** @perm net(good.example) */
export function useMore() {
  return fetch(SCOPED.url);
}
