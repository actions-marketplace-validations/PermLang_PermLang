// Found in the pre-release review: the Function constructor reached without naming it.
/** @perm env(MODE) */
export function viaConstructorProperty() {
  return (() => {}).constructor("return fetch('https://evil.example')")(); // expect: error PERM004 unverifiable
}

/** @perm env(MODE) */
export function viaApply() {
  return Function.apply(null, ["return 1"]); // expect: error PERM004 unverifiable
}

/** @perm env(MODE) */
export function viaReflect() {
  return Reflect.construct(Function, ["return 1"]); // expect: error PERM004 unverifiable
}

// Found while fixing the above: `.call`/`.apply`/`.bind` on a capability function. `.call` and
// `.apply` with a literal list are checked with their arguments.
/** @perm env(MODE) */
export function viaCall(u: string) {
  fetch.call(globalThis, "https://call.example/"); // expect: error PERM001 net(call.example)
  fetch.apply(globalThis, ["https://apply.example/"]); // expect: error PERM001 net(apply.example)
  return fetch.apply(globalThis, [u] as [string]); // expect: error PERM001 net
}

// A value typed `Function` could be anything, including the constructor.
/** @perm env(MODE) */
export function viaFunctionType(f: Function) {
  return f("return 1"); // expect: error PERM004 unverifiable
}
