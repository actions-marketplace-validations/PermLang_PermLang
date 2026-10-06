// References to fixed values that read them, in every position next to a write.
enum Route {
  Home = "https://good.example/",
}
const LIMITS = { retries: 3, key: "MODE", list: ["a"] } as const;

/** @perm env(MODE) */
export function reads(table: Record<string, number>, n: number) {
  const pinned = Route.Home as const;
  for (const item of LIMITS.list) void item;
  return [
    table[Route.Home],
    LIMITS.key === "MODE",
    n === LIMITS.retries,
    LIMITS.key in process.env,
    -LIMITS.retries,
    [LIMITS.key],
    pinned,
  ];
}

/** @perm net(good.example) */
export function use() {
  return fetch(Route.Home);
}
