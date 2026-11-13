import { RedisCacheService } from "@rag/cache";
import { createDatabaseConnection, IngestionDatabaseRepository } from "@rag/db";
import { LocalEmbeddingsEngine } from "@rag/embeddings";
import { KafkaEventsService } from "@rag/events";
import { ElasticSearchService } from "@rag/search";
import { parseEnv } from "@rag/shared-types";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const env = parseEnv();
  const { db, sql } = createDatabaseConnection(env.DATABASE_URL);
  const dbRepo = new IngestionDatabaseRepository(db, sql);
  await dbRepo.initSchema();

  const cacheService = RedisCacheService.fromUrl(env.REDIS_URL);
  const searchService = ElasticSearchService.fromNode(
    env.ELASTICSEARCH_NODE,
    env.ELASTICSEARCH_USE_NATIVE_RRF,
  );
  await searchService.ensureIndex();

  const eventsService = KafkaEventsService.fromBrokersString(
    env.KAFKA_BROKERS,
    `${env.KAFKA_CLIENT_ID}-api`,
  );
  await eventsService.ensureTopics();

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

  const shutdown = async () => {
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
