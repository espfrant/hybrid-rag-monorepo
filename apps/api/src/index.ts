import { RedisCacheService } from "@rag/cache";
import { createDatabaseConnection, IngestionDatabaseRepository } from "@rag/db";
import { LocalEmbeddingsEngine } from "@rag/embeddings";
import { KafkaEventsService } from "@rag/events";
import { ElasticSearchService } from "@rag/search";
import { parseEnv } from "@rag/shared-types";
import { buildApp } from "./app.js";

async function bootstrapInfrastructure(
  deps: {
    initSchema: () => Promise<void>;
    ensureIndex: () => Promise<void>;
    ensureTopics: () => Promise<void>;
  },
  isShuttingDown: () => boolean,
): Promise<void> {
  const done = { schema: false, index: false, topics: false };
  let attempt = 0;

  while (!isShuttingDown() && !(done.schema && done.index && done.topics)) {
    attempt += 1;
    try {
      if (!done.schema) {
        await deps.initSchema();
        done.schema = true;
      }
      if (!done.index) {
        await deps.ensureIndex();
        done.index = true;
      }
      if (!done.topics) {
        await deps.ensureTopics();
        done.topics = true;
      }
      console.info("Infrastructure bootstrap completed (Postgres, Elasticsearch, Kafka)");
      return;
    } catch (error) {
      if (isShuttingDown()) {
        return;
      }
      const delayMs = Math.min(2000 * attempt, 10000);
      console.warn(
        `Infrastructure bootstrap attempt ${attempt} waiting for dependencies; retrying in ${delayMs}ms:`,
        error instanceof Error ? error.message : String(error),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const env = parseEnv();
  const { db, sql } = createDatabaseConnection(env.DATABASE_URL);
  const dbRepo = new IngestionDatabaseRepository(db, sql);

  const cacheService = RedisCacheService.fromUrl(env.REDIS_URL);
  const searchService = ElasticSearchService.fromNode(
    env.ELASTICSEARCH_NODE,
    env.ELASTICSEARCH_USE_NATIVE_RRF,
  );

  const eventsService = KafkaEventsService.fromBrokersString(
    env.KAFKA_BROKERS,
    `${env.KAFKA_CLIENT_ID}-api`,
  );

  const embeddingsEngine = LocalEmbeddingsEngine.getInstance({
    model: env.EMBEDDINGS_MODEL,
    mock: env.EMBEDDINGS_MOCK,
  });

  const app = buildApp({
    dbRepo,
    cacheService,
    searchService,
    eventsService,
    embeddingsEngine,
  });

  await app.listen({ port: env.PORT, host: env.HOST });
  console.info(`API & MCP Server listening on http://${env.HOST}:${env.PORT}`);

  let shuttingDown = false;
  void bootstrapInfrastructure(
    {
      initSchema: () => dbRepo.initSchema(),
      ensureIndex: () => searchService.ensureIndex(),
      ensureTopics: () => eventsService.ensureTopics(),
    },
    () => shuttingDown,
  );

  const shutdown = async () => {
    shuttingDown = true;
    await app.close();
    await eventsService.disconnect();
    await cacheService.close();
    await searchService.close();
    await dbRepo.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("API server fatal error:", error);
  process.exit(1);
});
