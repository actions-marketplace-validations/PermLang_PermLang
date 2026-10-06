export function go() {
  return fetch("https://helper.example/"); // expect: error PERM003 net(helper.example)
}
