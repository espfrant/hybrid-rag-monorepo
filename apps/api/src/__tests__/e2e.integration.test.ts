import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RedisCacheService } from "@rag/cache";
import { createDatabaseConnection, IngestionDatabaseRepository } from "@rag/db";
import { LocalEmbeddingsEngine } from "@rag/embeddings";
import { KafkaEventsService } from "@rag/events";
import { ElasticSearchService } from "@rag/search";
import { processIngestionEvent } from "@rag/worker/ingestion";
import { ElasticsearchContainer } from "@testcontainers/elasticsearch";
import { KafkaContainer } from "@testcontainers/kafka";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);

async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hybrid-rag-e2e-repo-"));
  await writeFile(
    join(dir, "ranker.ts"),
    [
      "export function computeReciprocalRankFusion(ranks: number[], k = 60): number {",
      "  return ranks.reduce((acc, r) => acc + 1 / (k + r), 0);",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "ARCHITECTURE.md"),
    [
      "# Hybrid Search Pipeline",
      "",
      "## Reciprocal Rank Fusion",
      "Combines BM25 lexical matching with 768-dimensional local ONNX cosine kNN.",
    ].join("\n"),
  );

  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "ci@hybrid-rag.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Hybrid RAG CI"], { cwd: dir });
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "feat: initial ranker and docs"], { cwd: dir });
  return dir;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null) {
      return val;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("E2E Hybrid RAG + MCP Integration (Testcontainers)", () => {
  let pgCleanup: (() => Promise<void>) | undefined;
  let redisCleanup: (() => Promise<void>) | undefined;
  let kafkaCleanup: (() => Promise<void>) | undefined;
  let esCleanup: (() => Promise<void>) | undefined;
  let tempGitDir: string | undefined;

  let dbRepo: IngestionDatabaseRepository;
  let cacheService: RedisCacheService;
  let searchService: ElasticSearchService;
  let apiEvents: KafkaEventsService;
  let workerEvents: KafkaEventsService;
  let apiUrl: string;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const [pgContainer, redisContainer, kafkaContainer, esContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine")
        .withDatabase("hybrid_rag")
        .withUsername("postgres")
        .withPassword("postgres")
        .start(),
      new RedisContainer("redis:7-alpine").start(),
      new KafkaContainer("confluentinc/cp-kafka:7.6.1").withKraft().start(),
      new ElasticsearchContainer("docker.elastic.co/elasticsearch/elasticsearch:8.15.0")
        .withEnvironment({
          ES_JAVA_OPTS: "-Xms512m -Xmx512m",
        })
        .start(),
    ]);

    pgCleanup = () => pgContainer.stop().then(() => undefined);
    redisCleanup = () => redisContainer.stop().then(() => undefined);
    kafkaCleanup = () => kafkaContainer.stop().then(() => undefined);
    esCleanup = () => esContainer.stop().then(() => undefined);

    const { db, sql } = createDatabaseConnection(pgContainer.getConnectionUri());
    dbRepo = new IngestionDatabaseRepository(db, sql);
    await dbRepo.initSchema();

    cacheService = RedisCacheService.fromUrl(redisContainer.getConnectionUrl());
    searchService = ElasticSearchService.fromNode(esContainer.getHttpUrl(), false, {
      username: esContainer.getUsername(),
      password: esContainer.getPassword(),
    });
    await searchService.ensureIndex();

    const kafkaBrokers = [`${kafkaContainer.getHost()}:${kafkaContainer.getMappedPort(9093)}`];
    apiEvents = new KafkaEventsService(kafkaBrokers, "e2e-api");
    workerEvents = new KafkaEventsService(kafkaBrokers, "e2e-worker");
    await apiEvents.ensureTopics();

    const embeddingsEngine = LocalEmbeddingsEngine.getInstance({ mock: true });

    await workerEvents.startIngestionConsumer(
      async (event) => {
        await processIngestionEvent(event, {
          dbRepo,
          searchService,
          cacheService,
          embeddingsEngine,
        });
      },
      { groupId: "rag-ingestion-workers-e2e" },
    );

    const app = buildApp({
      dbRepo,
      cacheService,
      searchService,
      eventsService: apiEvents,
      embeddingsEngine,
    });
    apiUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    closeApp = () => app.close();

    tempGitDir = await createTempGitRepo();
  });

  afterAll(async () => {
    await closeApp?.();
    await workerEvents?.disconnect();
    await apiEvents?.disconnect();
    await cacheService?.close();
    await searchService?.close();
    await dbRepo?.close();
    if (tempGitDir) {
      await rm(tempGitDir, { recursive: true, force: true });
    }
    await Promise.all([pgCleanup?.(), redisCleanup?.(), kafkaCleanup?.(), esCleanup?.()]);
  });

  it("ingests repository via POST -> Kafka -> Worker -> Elasticsearch and serves MCP search with Redis cache hit", async () => {
    // 1. Trigger ingestion via REST API
    const postRes = await fetch(`${apiUrl}/api/v1/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "e2e-rag-sample",
        url: tempGitDir,
        defaultBranch: "main",
      }),
    });
    expect(postRes.status).toBe(202);
    const accepted = (await postRes.json()) as {
      repositoryId: string;
      jobId: string;
      status: string;
    };
    expect(accepted.status).toBe("QUEUED");

    // 2. Wait for Kafka -> Worker -> ES -> PG READY
    const readyRepo = await waitFor(async () => {
      const repo = await dbRepo.getRepositoryById(accepted.repositoryId);
      if (repo?.status === "READY" && repo.latestJob?.status === "COMPLETED") {
        return repo;
      }
      return null;
    });
    expect(readyRepo.lastIndexedCommit).toBeTruthy();
    expect(readyRepo.latestJob?.totalChunks).toBeGreaterThanOrEqual(2);

    // 3. Call MCP `search_technical_docs` (1st call = cache miss, hits Elasticsearch)
    const mcpHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const firstMcpRes = await fetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_technical_docs",
          arguments: {
            query: "computeReciprocalRankFusion",
            repositoryName: "e2e-rag-sample",
          },
        },
      }),
    });
    expect(firstMcpRes.status).toBe(200);
    const firstBody = (await firstMcpRes.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const firstPayload = JSON.parse(firstBody.result.content[0]?.text ?? "{}") as {
      cached: boolean;
      results: Array<{
        filePath: string;
        symbolName: string;
        startLine: number;
        endLine: number;
      }>;
    };

    expect(firstPayload.cached).toBe(false);
    const hit = firstPayload.results.find((r) => r.symbolName === "computeReciprocalRankFusion");
    expect(hit).toBeDefined();
    expect(hit?.filePath).toBe("ranker.ts");
    expect(hit?.startLine).toBe(1);
    expect(hit?.endLine).toBe(3);

    // 4. Call MCP `search_technical_docs` a second time -> must hit Redis cache
    const secondMcpRes = await fetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_technical_docs",
          arguments: {
            query: "computeReciprocalRankFusion",
            repositoryName: "e2e-rag-sample",
          },
        },
      }),
    });
    expect(secondMcpRes.status).toBe(200);
    const secondBody = (await secondMcpRes.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const secondPayload = JSON.parse(secondBody.result.content[0]?.text ?? "{}") as {
      cached: boolean;
      results: Array<{ symbolName: string }>;
    };
    expect(secondPayload.cached).toBe(true);
    expect(secondPayload.results.length).toBeGreaterThanOrEqual(1);

    // 5. Verify `get_symbol_definition` and `list_indexed_repositories`
    const symbolRes = await fetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_symbol_definition",
          arguments: { symbolName: "computeReciprocalRankFusion" },
        },
      }),
    });
    expect(symbolRes.status).toBe(200);
    const symbolBody = JSON.parse(
      ((await symbolRes.json()) as { result: { content: Array<{ text: string }> } }).result
        .content[0]?.text ?? "{}",
    ) as { total: number };
    expect(symbolBody.total).toBeGreaterThanOrEqual(1);
  });
});
