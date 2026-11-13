import { describe, expect, it } from "vitest";
import { buildSearchCacheKey, RedisCacheService, type RedisLike } from "../index.js";

class InMemoryRedisMock implements RedisLike {
  private readonly store = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _expiryMode: "EX", _time: number): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    this.sets.set(key, set);
    return added;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      this.sets.delete(key);
    }
    return count;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return "OK";
  }
}

describe("@rag/cache", () => {
  it("builds deterministic search cache keys independent of property order", () => {
    const k1 = buildSearchCacheKey({ query: "kafka", topK: 8, repositoryName: undefined });
    const k2 = buildSearchCacheKey({ topK: 8, query: "kafka" });
    expect(k1).toBe(k2);
    expect(k1.startsWith("search:")).toBe(true);
  });

  it("caches values on miss, serves on hit, and invalidates by repositoryId", async () => {
    const redis = new InMemoryRedisMock();
    const cache = new RedisCacheService(redis);
    const key = buildSearchCacheKey({ query: "hybrid" });

    let calls = 0;
    const first = await cache.getOrSet(
      key,
      600,
      async () => {
        calls++;
        return { hits: [1, 2, 3] };
      },
      "repo-1",
    );
    expect(first.cached).toBe(false);
    expect(first.value).toEqual({ hits: [1, 2, 3] });
    expect(calls).toBe(1);

    const second = await cache.getOrSet(
      key,
      600,
      async () => {
        calls++;
        return { hits: [999] };
      },
      "repo-1",
    );
    expect(second.cached).toBe(true);
    expect(second.value).toEqual({ hits: [1, 2, 3] });
    expect(calls).toBe(1);

    const deleted = await cache.invalidateRepoCache("repo-1");
    expect(deleted).toBe(1);

    const third = await cache.getOrSet(
      key,
      600,
      async () => {
        calls++;
        return { hits: [4, 5] };
      },
      "repo-1",
    );
    expect(third.cached).toBe(false);
    expect(third.value).toEqual({ hits: [4, 5] });
    expect(calls).toBe(2);
  });
});
