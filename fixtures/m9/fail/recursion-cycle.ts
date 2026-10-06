// Found while making propagation linear: in a cycle of calls, every function reaches
// what any of them does, however far round the cycle it is.
function a(n: number): unknown {
  return n > 0 ? b(n - 1) : stamp();
}
function stamp() {
  return Date.now();
}
function b(n: number): unknown {
  return n > 0 ? c(n - 1) : fetch("https://cycle.example/");
}
function c(n: number): unknown {
  return a(n);
}

/** @perm env(N) */
export function start() {
  return c(5); // expect: error PERM001 net(cycle.example)
}
