import { describe, expect, it } from "vitest";
import {
  CreateRepositoryRequestSchema,
  GetSymbolDefinitionInputSchema,
  IngestionDlqEventSchema,
  IngestionRequestedEventSchema,
  KAFKA_CONSUMER_GROUP,
  KAFKA_TOPICS,
  parseEnv,
  SearchTechnicalDocsInputSchema,
} from "../index.js";

describe("shared-types Zod schemas", () => {
  it("parses default environment configuration", () => {
    const env = parseEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.EMBEDDINGS_MODEL).toBe("Xenova/bge-base-en-v1.5");
    expect(env.EMBEDDINGS_MOCK).toBe(false);
    expect(env.ELASTICSEARCH_USE_NATIVE_RRF).toBe(false);
  });

  it("validates Kafka ingestion requested and DLQ events", () => {
    const requested = IngestionRequestedEventSchema.parse({
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      repositoryId: "550e8400-e29b-41d4-a716-446655440001",
      repositoryUrl: "https://github.com/org/repo.git",
      branch: "main",
      requestedAt: "2026-11-13T12:00:00Z",
    });

    expect(requested.branch).toBe("main");
    expect(KAFKA_TOPICS.INGESTION_REQUESTED).toBe("docs.ingestion.requested");
    expect(KAFKA_TOPICS.INGESTION_DLQ).toBe("docs.ingestion.dlq");
    expect(KAFKA_CONSUMER_GROUP).toBe("rag-ingestion-workers");

    const dlq = IngestionDlqEventSchema.parse({
      originalEvent: requested,
      errorMessage: "git clone failed",
      attempts: 3,
      failedAt: "2026-11-13T12:05:00Z",
    });
    expect(dlq.attempts).toBe(3);
  });

  it("validates API DTOs and MCP input schemas with defaults", () => {
    const repo = CreateRepositoryRequestSchema.parse({
      name: "hybrid-rag",
      url: "https://github.com/org/repo.git",
    });
    expect(repo.defaultBranch).toBe("main");

    const searchInput = SearchTechnicalDocsInputSchema.parse({
      query: "Reciprocal Rank Fusion",
    });
    expect(searchInput.topK).toBe(8);

    const symbolInput = GetSymbolDefinitionInputSchema.parse({
      symbolName: "ElasticSearchService",
    });
    expect(symbolInput.symbolName).toBe("ElasticSearchService");
  });
});
