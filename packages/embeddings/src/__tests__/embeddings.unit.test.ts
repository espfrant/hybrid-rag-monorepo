import { afterEach, describe, expect, it } from "vitest";
import {
  createDeterministicEmbedding,
  EMBEDDING_DIMS,
  LocalEmbeddingsEngine,
  normalizeVectorL2,
} from "../index.js";

describe("@rag/embeddings", () => {
  afterEach(() => {
    LocalEmbeddingsEngine.resetInstanceForTesting();
  });

  it("maintains singleton identity and produces L2-normalized 768d vectors", async () => {
    const a = LocalEmbeddingsEngine.getInstance({ mock: true });
    const b = LocalEmbeddingsEngine.getInstance({ mock: true });
    expect(a).toBe(b);

    const vector = await a.embedText("hybrid search reciprocal rank fusion");
    expect(vector).toHaveLength(EMBEDDING_DIMS);

    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("produces higher cosine similarity for semantically overlapping texts in mock mode", () => {
    const v1 = createDeterministicEmbedding("function searchTechnicalDocs query elasticsearch");
    const v2 = createDeterministicEmbedding("searchTechnicalDocs elasticsearch query");
    const v3 = createDeterministicEmbedding("unrelated kubernetes persistent volume claim");

    const cosine = (x: number[], y: number[]) =>
      x.reduce((sum, val, idx) => sum + val * (y[idx] ?? 0), 0);

    expect(cosine(v1, v2)).toBeGreaterThan(cosine(v1, v3));
  });

  it("normalizes arbitrary vectors and supports batching", async () => {
    const normVec = normalizeVectorL2([3, 4, 0]);
    expect(normVec[0]).toBeCloseTo(0.6, 5);
    expect(normVec[1]).toBeCloseTo(0.8, 5);

    const engine = LocalEmbeddingsEngine.getInstance({ mock: true });
    const batch = await engine.embedBatch(["alpha", "beta", "gamma"], 2);
    expect(batch).toHaveLength(3);
    for (const vec of batch) {
      expect(vec).toHaveLength(EMBEDDING_DIMS);
    }
  });
});
