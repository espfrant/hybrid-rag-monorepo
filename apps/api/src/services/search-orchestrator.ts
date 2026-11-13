import { buildSearchCacheKey, type RedisCacheService } from "@rag/cache";
import type { IngestionDatabaseRepository } from "@rag/db";
import type { LocalEmbeddingsEngine } from "@rag/embeddings";
import type { KafkaEventsService } from "@rag/events";
import type { ElasticSearchService } from "@rag/search";
import type { SearchRequest, SearchResult } from "@rag/shared-types";

export interface ApiDependencies {
  dbRepo: Pick<
    IngestionDatabaseRepository,
    | "createRepositoryWithJob"
    | "listRepositories"
    | "listReadyRepositories"
    | "deleteRepository"
    | "ping"
    | "close"
  >;
  cacheService: Pick<RedisCacheService, "getOrSet" | "invalidateRepoCache" | "ping" | "close">;
  searchService: Pick<
    ElasticSearchService,
    "hybridSearch" | "getSymbolDefinition" | "deleteRepositoryChunks" | "ping" | "close"
  >;
  eventsService: Pick<KafkaEventsService, "publishIngestionRequested" | "ping" | "disconnect">;
  embeddingsEngine: Pick<LocalEmbeddingsEngine, "embedText">;
}

export const SEARCH_CACHE_TTL_SECONDS = 600;

export async function executeHybridSearch(
  input: SearchRequest,
  deps: Pick<ApiDependencies, "cacheService" | "searchService" | "embeddingsEngine" | "dbRepo">,
): Promise<SearchResult> {
  const topK = input.topK ?? 8;
  const cacheKey = buildSearchCacheKey({
    query: input.query,
    repositoryName: input.repositoryName,
    language: input.language,
    topK,
  });

  let repoIdForCache: string | undefined;
  if (input.repositoryName) {
    const repos = await deps.dbRepo.listReadyRepositories();
    repoIdForCache = repos.find((r) => r.name === input.repositoryName)?.id;
  }

  const { value, cached } = await deps.cacheService.getOrSet(
    cacheKey,
    SEARCH_CACHE_TTL_SECONDS,
    async () => {
      const embedding = await deps.embeddingsEngine.embedText(input.query);
      return deps.searchService.hybridSearch({
        query: input.query,
        embedding,
        repositoryName: input.repositoryName,
        language: input.language,
        topK,
      });
    },
    repoIdForCache,
  );

  return {
    query: input.query,
    cached,
    total: value.length,
    results: value,
  };
}
