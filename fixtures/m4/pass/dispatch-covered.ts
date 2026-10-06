interface Cache {
  getCached(key: string): Promise<unknown>;
}

class RedisCache implements Cache {
  async getCached(key: string) {
    return fetch(`https://cache.example/${key}`);
  }
}

class MemoryCache implements Cache {
  private readonly items = new Map<string, unknown>();
  async getCached(key: string) {
    return this.items.get(key);
  }
}

// Every implementation is covered, so the interface call passes. (Any class or object
// literal in the project that could stand in for Cache counts too; all fixtures are one
// project, so the method has a name no other fixture uses.)
/** @perm net(cache.example) */
export function lookup(c: Cache, key: string) {
  return c.getCached(key);
}

export const caches = [new RedisCache(), new MemoryCache()];
