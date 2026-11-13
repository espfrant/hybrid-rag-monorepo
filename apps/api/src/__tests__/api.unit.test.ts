import { LocalEmbeddingsEngine } from "@rag/embeddings";
import type { RepositoryResponse, SearchHit } from "@rag/shared-types";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { ApiDependencies } from "../services/search-orchestrator.js";

function createMockDeps(): {
  deps: ApiDependencies;
  cacheStore: Map<string, string>;
} {
  const cacheStore = new Map<string, string>();
  const sampleHit: SearchHit = {
    chunkId: "chunk-1",
    repositoryId: "550e8400-e29b-41d4-a716-446655440001",
    repositoryName: "hybrid-rag",
    filePath: "src/search.ts",
    language: "typescript",
    symbolName: "computeScore",
    symbolType: "function",
    content: "export function computeScore(rank: number) { return 1 / (60 + rank); }",
    startLine: 11,
    endLine: 13,
    commitHash: "abc1234",
    score: 0.92,
  };

  const sampleRepo: RepositoryResponse = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    name: "hybrid-rag",
    url: "https://github.com/org/hybrid-rag.git",
    defaultBranch: "main",
    status: "READY",
    lastIndexedCommit: "abc1234",
    createdAt: "2026-11-13T12:00:00.000Z",
    updatedAt: "2026-11-13T12:01:00.000Z",
    latestJob: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      repositoryId: "550e8400-e29b-41d4-a716-446655440001",
      commitHash: "abc1234",
      status: "COMPLETED",
      totalChunks: 1,
      errorMessage: null,
      startedAt: "2026-11-13T12:00:05.000Z",
      completedAt: "2026-11-13T12:01:00.000Z",
    },
  };

  const deps: ApiDependencies = {
    dbRepo: {
      createRepositoryWithJob: vi.fn().mockResolvedValue({
        repository: sampleRepo,
        job: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          repositoryId: sampleRepo.id,
          commitHash: null,
          status: "QUEUED",
          totalChunks: 0,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      }),
      listRepositories: vi.fn().mockResolvedValue([sampleRepo]),
      listReadyRepositories: vi.fn().mockResolvedValue([sampleRepo]),
      deleteRepository: vi.fn().mockResolvedValue(true),
      ping: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    },
    cacheService: {
      getOrSet: vi.fn(async (key, _ttl, fetcher) => {
        const hit = cacheStore.get(key);
        if (hit) {
          return { value: JSON.parse(hit), cached: true };
        }
        const value = await fetcher();
        cacheStore.set(key, JSON.stringify(value));
        return { value, cached: false };
      }),
      invalidateRepoCache: vi.fn().mockResolvedValue(1),
      ping: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    },
    searchService: {
      hybridSearch: vi.fn().mockResolvedValue([sampleHit]),
      getSymbolDefinition: vi.fn().mockResolvedValue([sampleHit]),
      deleteRepositoryChunks: vi.fn().mockResolvedValue(12),
      ping: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    },
    eventsService: {
      publishIngestionRequested: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
    },
    embeddingsEngine: LocalEmbeddingsEngine.getInstance({ mock: true }),
  };

  return { deps, cacheStore };
}

describe("@rag/api REST & MCP server", () => {
  it("responds to /healthz and /readyz probes", async () => {
    const { deps } = createMockDeps();
    const app = buildApp(deps);

    const healthRes = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({ status: "ok" });

    const readyRes = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toEqual({
      status: "ready",
      dependencies: {
        postgres: true,
        redis: true,
        elasticsearch: true,
        kafka: true,
      },
    });

    await app.close();
  });

  it("registers repository in PostgreSQL, publishes Kafka event, and returns 202 Accepted", async () => {
    const { deps } = createMockDeps();
    const app = buildApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/repositories",
      payload: {
        name: "hybrid-rag",
        url: "https://github.com/org/hybrid-rag.git",
        defaultBranch: "main",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      repositoryId: "550e8400-e29b-41d4-a716-446655440001",
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      status: "QUEUED",
    });
    expect(deps.eventsService.publishIngestionRequested).toHaveBeenCalledTimes(1);

    const listRes = await app.inject({ method: "GET", url: "/api/v1/repositories" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().repositories).toHaveLength(1);

    await app.close();
  });

  it("caches hybrid search responses in Redis on second invocation", async () => {
    const { deps } = createMockDeps();
    const app = buildApp(deps);

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/search",
      payload: { query: "computeScore", topK: 5 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().cached).toBe(false);
    expect(deps.searchService.hybridSearch).toHaveBeenCalledTimes(1);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/search",
      payload: { query: "computeScore", topK: 5 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().cached).toBe(true);
    expect(deps.searchService.hybridSearch).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("exposes search_technical_docs, get_symbol_definition, and list_indexed_repositories via /mcp", async () => {
    const { deps } = createMockDeps();
    const app = buildApp(deps);

    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const listToolsRes = await fetch(`${address}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(listToolsRes.status).toBe(200);
    const listBody = (await listToolsRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = listBody.result.tools.map((t) => t.name);
    expect(names).toContain("search_technical_docs");
    expect(names).toContain("get_symbol_definition");
    expect(names).toContain("list_indexed_repositories");

    const callSearchRes = await fetch(`${address}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search_technical_docs",
          arguments: { query: "computeScore" },
        },
      }),
    });
    expect(callSearchRes.status).toBe(200);
    const callSearchBody = (await callSearchRes.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const parsedSearch = JSON.parse(callSearchBody.result.content[0]?.text ?? "{}") as {
      cached: boolean;
      results: Array<{ symbolName: string; startLine: number }>;
    };
    expect(parsedSearch.cached).toBe(false);
    expect(parsedSearch.results[0]?.symbolName).toBe("computeScore");
    expect(parsedSearch.results[0]?.startLine).toBe(11);

    const callListReposRes = await fetch(`${address}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_indexed_repositories",
          arguments: {},
        },
      }),
    });
    expect(callListReposRes.status).toBe(200);
    const reposBody = (await callListReposRes.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const parsedRepos = JSON.parse(reposBody.result.content[0]?.text ?? "{}") as {
      total: number;
    };
    expect(parsedRepos.total).toBe(1);

    await app.close();
  });

  it("supports REST symbol lookup and repository deletion", async () => {
    const { deps } = createMockDeps();
    const app = buildApp(deps);

    const symRes = await app.inject({
      method: "GET",
      url: "/api/v1/symbols?symbolName=computeScore",
    });
    expect(symRes.statusCode).toBe(200);
    expect(symRes.json().total).toBe(1);

    const delRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/repositories/550e8400-e29b-41d4-a716-446655440001",
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({
      deleted: true,
      id: "550e8400-e29b-41d4-a716-446655440001",
      deletedChunks: 12,
    });
    expect(deps.cacheService.invalidateRepoCache).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440001",
    );

    await app.close();
  });
});
