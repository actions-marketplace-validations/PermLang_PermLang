// limit: a Proxy trap can return a capability function for any property name. The
// handler is an object of functions handed to `new Proxy`, so its traps are entry points
// (or, created in a function, charged to that function), but a call through the Proxy
// isn't linked to them, so call() is not failed.
const net = new Proxy({} as Record<string, unknown>, { get: () => fetch }); // expect: error PERM003 net

/** @perm env(MODE) */
export function call() {
  return (net.anything as (url: string) => unknown)("https://proxy.example/");
}
