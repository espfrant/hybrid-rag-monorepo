import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  GetSymbolDefinitionInputSchema,
  ListIndexedRepositoriesInputSchema,
  SearchTechnicalDocsInputSchema,
} from "@rag/shared-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ApiDependencies, executeHybridSearch } from "../services/search-orchestrator.js";

export function createRagMcpServer(deps: ApiDependencies): McpServer {
  const server = new McpServer({
    name: "hybrid-rag-engine",
    version: "0.1.0",
  });

  server.registerTool(
    "search_technical_docs",
    {
      title: "Search Technical Docs & Code",
      description:
        "Hybrid search (BM25 + local 768d ONNX embeddings with RRF) over indexed repositories and documentation.",
      inputSchema: SearchTechnicalDocsInputSchema,
    },
    async (args) => {
      const result = await executeHybridSearch(
        {
          query: args.query,
          repositoryName: args.repositoryName,
          language: args.language,
          topK: args.topK ?? 8,
        },
        deps,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_symbol_definition",
    {
      title: "Get Symbol Definition",
      description:
        "Exact lexical lookup of a code symbol (function, class, interface) in Elasticsearch.",
      inputSchema: GetSymbolDefinitionInputSchema,
    },
    async (args) => {
      const hits = await deps.searchService.getSymbolDefinition(
        args.symbolName,
        args.repositoryName,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                symbolName: args.symbolName,
                total: hits.length,
                definitions: hits,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_indexed_repositories",
    {
      title: "List Indexed Repositories",
      description: "Lists repositories in READY state with their last indexed commit hash.",
      inputSchema: ListIndexedRepositoriesInputSchema,
    },
    async () => {
      const repos = await deps.dbRepo.listReadyRepositories();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: repos.length,
                repositories: repos.map((r) => ({
                  id: r.id,
                  name: r.name,
                  url: r.url,
                  defaultBranch: r.defaultBranch,
                  lastIndexedCommit: r.lastIndexedCommit,
                  updatedAt: r.updatedAt,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

export function registerMcpRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  const handleMcpRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const mcpServer = createRagMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.hijack();
    await mcpServer.connect(transport);
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  };

  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", handleMcpRequest);
  app.delete("/mcp", handleMcpRequest);
}
