import { createHash } from "node:crypto";
import { Redis } from "ioredis";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", time: number): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

const GLOBAL_CACHE_SET = "repo_cache:__all__";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function buildSearchCacheKey(input: unknown): string {
  const hash = createHash("sha256").update(canonicalize(input)).digest("hex");
  return `search:${hash}`;
}

export class RedisCacheService {
  constructor(private readonly client: RedisLike) {}

  static fromUrl(redisUrl: string): RedisCacheService {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    return new RedisCacheService(client);
  }

  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>,
    repoId?: string,
  ): Promise<{ value: T; cached: boolean }> {
    const existing = await this.client.get(key);
    if (existing !== null) {
      return { value: JSON.parse(existing) as T, cached: true };
    }

    const value = await fetcher();
    await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);

    const indexKey = repoId ? `repo_cache:${repoId}` : GLOBAL_CACHE_SET;
    await this.client.sadd(indexKey, key);
    await this.client.expire(indexKey, Math.max(ttlSeconds, 3600));

    return { value, cached: false };
  }

  async invalidateRepoCache(repoId: string): Promise<number> {
    const repoSetKey = `repo_cache:${repoId}`;
    const [repoKeys, globalKeys] = await Promise.all([
      this.client.smembers(repoSetKey),
      this.client.smembers(GLOBAL_CACHE_SET),
    ]);

    const keysToDelete = Array.from(new Set([...repoKeys, ...globalKeys]));
    let deleted = 0;

    if (keysToDelete.length > 0) {
      deleted = await this.client.del(...keysToDelete);
    }

    await this.client.del(repoSetKey, GLOBAL_CACHE_SET);
    return deleted;
  }

  async ping(): Promise<boolean> {
    const res = await this.client.ping();
    return res === "PONG";
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
