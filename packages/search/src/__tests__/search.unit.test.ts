import type { Client } from "@elastic/elasticsearch";
import { describe, expect, it, vi } from "vitest";
import {
  CHUNKS_INDEX,
  computeDeterministicChunkId,
  ElasticSearchService,
  fuseWithRrf,
} from "../index.js";

describe("@rag/search", () => {
  it("generates deterministic SHA-256 chunk IDs for idempotency", () => {
    const id1 = computeDeterministicChunkId("repo-1", "src/index.ts", 10, "abc123");
    const id2 = computeDeterministicChunkId("repo-1", "src/index.ts", 10, "abc123");
    const id3 = computeDeterministicChunkId("repo-1", "src/index.ts", 11, "abc123");

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toHaveLength(64);
  });

  it("fuses lexical and vector rankings using Reciprocal Rank Fusion", () => {
    const makeHit = (chunkId: string, score: number) => ({
      chunkId,
      repositoryId: "550e8400-e29b-41d4-a716-446655440000",
      repositoryName: "repo",
      filePath: `${chunkId}.ts`,
      language: "typescript",
      symbolName: chunkId,
      symbolType: "function" as const,
      content: `function ${chunkId}() {}`,
      startLine: 1,
      endLine: 3,
      commitHash: "abc",
      score,
    });

    const lexical = [makeHit("a", 10), makeHit("b", 8), makeHit("c", 5)];
    const vector = [makeHit("b", 0.95), makeHit("d", 0.91), makeHit("a", 0.85)];

    const fused = fuseWithRrf(lexical, vector, 3);
    expect(fused).toHaveLength(3);
    // "b" is rank 2 in lexical + rank 1 in vector -> highest RRF score
    expect(fused[0]?.chunkId).toBe("b");
    // "a" is rank 1 in lexical + rank 3 in vector -> second highest RRF score
    expect(fused[1]?.chunkId).toBe("a");
  });

  it("creates index with 768d HNSW mapping when index does not exist", async () => {
    const createMock = vi.fn().mockResolvedValue({ acknowledged: true });
    const mockClient = {
      indices: {
        exists: vi.fn().mockResolvedValue(false),
        create: createMock,
      },
    } as unknown as Client;

    const service = new ElasticSearchService(mockClient);
    await service.ensureIndex();

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]?.[0];
    expect(arg.index).toBe(CHUNKS_INDEX);
    expect(arg.mappings.properties.embedding.dims).toBe(768);
    expect(arg.mappings.properties.embedding.index_options.type).toBe("hnsw");
  });
});
