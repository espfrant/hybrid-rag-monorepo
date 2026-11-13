import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEmbeddingsEngine } from "@rag/embeddings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processIngestionEvent } from "../ingestion-worker.js";

describe("@rag/worker processIngestionEvent", () => {
  afterEach(() => {
    LocalEmbeddingsEngine.resetInstanceForTesting();
  });

  it("chunks local directory, generates embeddings, indexes ES, invalidates Redis, and completes PG job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-worker-test-"));
    try {
      await writeFile(
        join(dir, "calculator.ts"),
        "export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n",
      );

      const markJobProcessing = vi.fn().mockResolvedValue(undefined);
      const markJobCompleted = vi.fn().mockResolvedValue(undefined);
      const markJobFailed = vi.fn().mockResolvedValue(undefined);
      const getRepositoryById = vi.fn().mockResolvedValue({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "calc-repo",
      });
      const ensureIndex = vi.fn().mockResolvedValue(undefined);
      const bulkIndexChunks = vi.fn().mockResolvedValue(1);
      const invalidateRepoCache = vi.fn().mockResolvedValue(1);

      const result = await processIngestionEvent(
        {
          jobId: "550e8400-e29b-41d4-a716-446655440000",
          repositoryId: "550e8400-e29b-41d4-a716-446655440001",
          repositoryUrl: dir,
          branch: "main",
          requestedAt: "2026-11-13T12:00:00Z",
        },
        {
          dbRepo: {
            getRepositoryById,
            markJobProcessing,
            markJobCompleted,
            markJobFailed,
          },
          searchService: {
            ensureIndex,
            bulkIndexChunks,
          },
          cacheService: {
            invalidateRepoCache,
          },
          embeddingsEngine: LocalEmbeddingsEngine.getInstance({ mock: true }),
        },
      );

      expect(result.totalChunks).toBe(1);
      expect(markJobProcessing).toHaveBeenCalledTimes(1);
      expect(bulkIndexChunks).toHaveBeenCalledTimes(1);
      const indexedDocs = bulkIndexChunks.mock.calls[0]?.[0];
      expect(indexedDocs?.[0]?.symbolName).toBe("addNumbers");
      expect(indexedDocs?.[0]?.startLine).toBe(1);
      expect(indexedDocs?.[0]?.endLine).toBe(3);
      expect(indexedDocs?.[0]?.embedding).toHaveLength(768);
      expect(invalidateRepoCache).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440001");
      expect(markJobCompleted).toHaveBeenCalledTimes(1);
      expect(markJobFailed).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
