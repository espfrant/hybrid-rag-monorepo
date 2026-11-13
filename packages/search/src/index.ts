import { createHash } from "node:crypto";
import { Client } from "@elastic/elasticsearch";
import type { DocumentChunk, SearchHit } from "@rag/shared-types";

export const CHUNKS_INDEX = "code_and_docs_chunks";
export const EMBEDDING_DIMENSIONS = 768;
export const RRF_RANK_WINDOW_SIZE = 50;
export const RRF_RANK_CONSTANT = 60;

export interface IndexedChunkDocument extends DocumentChunk {
  embedding: number[];
}

export interface HybridSearchParams {
  query: string;
  embedding: number[];
  repositoryName?: string;
  language?: string;
  topK?: number;
}

/**
 * Deterministic SHA-256 ID ensuring idempotent indexing in Elasticsearch.
 */
export function computeDeterministicChunkId(
  repoId: string,
  filePath: string,
  startLine: number,
  commitHash: string,
): string {
  return createHash("sha256")
    .update(`${repoId}:${filePath}:${startLine}:${commitHash}`)
    .digest("hex");
}

/**
 * Combines BM25 lexical hits and kNN vector hits using Reciprocal Rank Fusion (RRF).
 */
export function fuseWithRrf(
  lexicalHits: SearchHit[],
  vectorHits: SearchHit[],
  topK: number,
  rankConstant = RRF_RANK_CONSTANT,
): SearchHit[] {
  const fused = new Map<string, { hit: SearchHit; score: number }>();

  lexicalHits.forEach((hit, index) => {
    const rrfScore = 1 / (rankConstant + (index + 1));
    const current = fused.get(hit.chunkId);
    fused.set(hit.chunkId, {
      hit,
      score: (current?.score ?? 0) + rrfScore,
    });
  });

  vectorHits.forEach((hit, index) => {
    const rrfScore = 1 / (rankConstant + (index + 1));
    const current = fused.get(hit.chunkId);
    fused.set(hit.chunkId, {
      hit: current?.hit ?? hit,
      score: (current?.score ?? 0) + rrfScore,
    });
  });

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ hit, score }) => ({ ...hit, score }));
}

function buildFilters(repositoryName?: string, language?: string): Array<Record<string, unknown>> {
  const filters: Array<Record<string, unknown>> = [];
  if (repositoryName) {
    filters.push({ term: { repositoryName } });
  }
  if (language) {
    filters.push({ term: { language } });
  }
  return filters;
}

function mapEsHits(hits: Array<{ _score?: number | null; _source?: unknown }>): SearchHit[] {
  const results: SearchHit[] = [];
  for (const hit of hits) {
    const src = hit._source as Partial<IndexedChunkDocument> | undefined;
    if (!src?.chunkId || !src.repositoryId || !src.filePath) {
      continue;
    }
    results.push({
      chunkId: src.chunkId,
      repositoryId: src.repositoryId,
      repositoryName: src.repositoryName ?? "",
      filePath: src.filePath,
      language: src.language ?? "text",
      symbolName: src.symbolName ?? "anonymous",
      symbolType: src.symbolType ?? "function",
      content: src.content ?? "",
      startLine: src.startLine ?? 1,
      endLine: src.endLine ?? 1,
      commitHash: src.commitHash ?? "unknown",
      score: hit._score ?? 0,
    });
  }
  return results;
}

export class ElasticSearchService {
  constructor(
    private readonly client: Client,
    private readonly useNativeRrf = false,
  ) {}

  static fromNode(
    nodeUrl: string,
    useNativeRrf = false,
    auth?: { username: string; password: string },
  ): ElasticSearchService {
    const client = new Client({
      node: nodeUrl,
      ...(auth ? { auth } : {}),
    });
    return new ElasticSearchService(client, useNativeRrf);
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: CHUNKS_INDEX });
    if (exists) {
      return;
    }

    await this.client.indices.create({
      index: CHUNKS_INDEX,
      settings: {
        analysis: {
          filter: {
            code_word_delimiter: {
              type: "word_delimiter_graph",
              generate_word_parts: true,
              generate_number_parts: true,
              split_on_case_change: true,
              split_on_numerics: true,
              preserve_original: true,
            },
          },
          analyzer: {
            code_analyzer: {
              type: "custom",
              tokenizer: "standard",
              filter: ["lowercase", "code_word_delimiter"],
            },
          },
        },
      },
      mappings: {
        properties: {
          chunkId: { type: "keyword" },
          repositoryId: { type: "keyword" },
          repositoryName: { type: "keyword" },
          filePath: { type: "keyword" },
          language: { type: "keyword" },
          symbolName: {
            type: "text",
            analyzer: "code_analyzer",
            fields: {
              keyword: { type: "keyword" },
            },
          },
          symbolType: { type: "keyword" },
          content: {
            type: "text",
            analyzer: "code_analyzer",
            search_analyzer: "code_analyzer",
          },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          commitHash: { type: "keyword" },
          embedding: {
            type: "dense_vector",
            dims: EMBEDDING_DIMENSIONS,
            index: true,
            similarity: "cosine",
            index_options: {
              type: "hnsw",
              m: 16,
              ef_construction: 100,
            },
          },
        },
      },
    });
  }

  async bulkIndexChunks(chunks: IndexedChunkDocument[]): Promise<number> {
    if (chunks.length === 0) {
      return 0;
    }

    const operations = chunks.flatMap((chunk) => [
      { index: { _index: CHUNKS_INDEX, _id: chunk.chunkId } },
      chunk,
    ]);

    const response = await this.client.bulk({
      refresh: true,
      operations,
    });

    if (response.errors) {
      const firstErr = response.items.find((item) => item.index?.error)?.index?.error;
      throw new Error(`Elasticsearch bulk index error: ${JSON.stringify(firstErr)}`);
    }

    return chunks.length;
  }

  async hybridSearch(params: HybridSearchParams): Promise<SearchHit[]> {
    const topK = params.topK ?? 8;
    const filters = buildFilters(params.repositoryName, params.language);

    if (this.useNativeRrf) {
      const response = await this.client.search({
        index: CHUNKS_INDEX,
        size: topK,
        // Native RRF retriever (Elasticsearch Enterprise/Platinum)
        retriever: {
          rrf: {
            retrievers: [
              {
                standard: {
                  query: {
                    bool: {
                      must: [
                        {
                          multi_match: {
                            query: params.query,
                            fields: ["content", "symbolName^3", "filePath^2"],
                          },
                        },
                      ],
                      filter: filters,
                    },
                  },
                },
              },
              {
                knn: {
                  field: "embedding",
                  query_vector: params.embedding,
                  k: RRF_RANK_WINDOW_SIZE,
                  num_candidates: 100,
                  filter: filters.length > 0 ? { bool: { filter: filters } } : undefined,
                },
              },
            ],
            rank_window_size: RRF_RANK_WINDOW_SIZE,
            rank_constant: RRF_RANK_CONSTANT,
          },
        },
      } as Parameters<Client["search"]>[0]);

      return mapEsHits(response.hits.hits);
    }

    // Dual-query RRF compatible with both Elasticsearch Basic and Enterprise licenses
    const [lexicalRes, vectorRes] = await Promise.all([
      this.client.search({
        index: CHUNKS_INDEX,
        size: RRF_RANK_WINDOW_SIZE,
        _source_excludes: ["embedding"],
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: params.query,
                  fields: ["content", "symbolName^3", "filePath^2"],
                },
              },
            ],
            filter: filters,
          },
        },
      }),
      this.client.search({
        index: CHUNKS_INDEX,
        size: RRF_RANK_WINDOW_SIZE,
        _source_excludes: ["embedding"],
        knn: {
          field: "embedding",
          query_vector: params.embedding,
          k: RRF_RANK_WINDOW_SIZE,
          num_candidates: 100,
          ...(filters.length > 0 ? { filter: filters } : {}),
        },
      }),
    ]);

    const lexicalHits = mapEsHits(lexicalRes.hits.hits);
    const vectorHits = mapEsHits(vectorRes.hits.hits);

    return fuseWithRrf(lexicalHits, vectorHits, topK, RRF_RANK_CONSTANT);
  }

  async getSymbolDefinition(symbolName: string, repositoryName?: string): Promise<SearchHit[]> {
    const filter: Array<Record<string, unknown>> = [{ term: { "symbolName.keyword": symbolName } }];
    if (repositoryName) {
      filter.push({ term: { repositoryName } });
    }

    const response = await this.client.search({
      index: CHUNKS_INDEX,
      size: 20,
      _source_excludes: ["embedding"],
      query: {
        bool: {
          filter,
        },
      },
    });

    return mapEsHits(response.hits.hits);
  }

  async deleteRepositoryChunks(repositoryId: string): Promise<number> {
    const exists = await this.client.indices.exists({ index: CHUNKS_INDEX });
    if (!exists) {
      return 0;
    }

    const response = await this.client.deleteByQuery({
      index: CHUNKS_INDEX,
      refresh: true,
      query: {
        term: { repositoryId },
      },
    });

    return response.deleted ?? 0;
  }

  async ping(): Promise<boolean> {
    await this.client.ping();
    return true;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
