import { RedisCacheService } from "@rag/cache";
import { createDatabaseConnection, IngestionDatabaseRepository } from "@rag/db";
import { LocalEmbeddingsEngine } from "@rag/embeddings";
import { KafkaEventsService } from "@rag/events";
import { ElasticSearchService } from "@rag/search";
import { parseEnv } from "@rag/shared-types";
import { processIngestionEvent } from "./ingestion-worker.js";

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

  const embeddingsEngine = LocalEmbeddingsEngine.getInstance({
    model: env.EMBEDDINGS_MODEL,
    mock: env.EMBEDDINGS_MOCK,
  });

  const eventsService = KafkaEventsService.fromBrokersString(
    env.KAFKA_BROKERS,
    `${env.KAFKA_CLIENT_ID}-worker`,
  );
  await eventsService.ensureTopics();

  await eventsService.startIngestionConsumer(async (event) => {
    await processIngestionEvent(event, {
      dbRepo,
      searchService,
      cacheService,
      embeddingsEngine,
    });
  });

  console.info("Worker listening on Kafka topic docs.ingestion.requested");

  const shutdown = async () => {
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
  console.error("Worker fatal error:", error);
  process.exit(1);
});
