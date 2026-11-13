import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../client.js";
import { IngestionDatabaseRepository } from "../repository.js";
import { ingestionJobs, repositories } from "../schema.js";

describe("@rag/db schema & repository", () => {
  it("defines expected Drizzle table columns", () => {
    expect(repositories.id.name).toBe("id");
    expect(repositories.url.name).toBe("url");
    expect(repositories.defaultBranch.name).toBe("default_branch");
    expect(repositories.lastIndexedCommit.name).toBe("last_indexed_commit");
    expect(ingestionJobs.repositoryId.name).toBe("repository_id");
    expect(ingestionJobs.totalChunks.name).toBe("total_chunks");
  });

  it("pings PostgreSQL using sql template tag", async () => {
    const mockSql = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const mockDb = {} as DatabaseClient;
    const repo = new IngestionDatabaseRepository(
      mockDb,
      mockSql as unknown as Parameters<
        typeof IngestionDatabaseRepository extends new (
          a: never,
          b: infer S,
        ) => unknown
          ? (b: S) => void
          : never
      >[0],
    );
    await expect(repo.ping()).resolves.toBe(true);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
