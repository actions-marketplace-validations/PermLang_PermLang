// Found in the 0.4 code review: require() returns `any`, so calls on what it loads
// don't resolve. A project file's exports are followed instead.
/** @perm env(MODE) */
export function run() {
  return require("./helper").go(); // expect: error PERM001 net(helper.example)
}
