void fetch("https://plugin-load.example/"); // expect: error PERM003 net(plugin-load.example)

export function start(mode?: string) {
  return fetch(`https://plugin.example/${mode}`); // expect: error PERM003 net(plugin.example)
}
