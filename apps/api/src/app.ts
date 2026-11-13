import { randomUUID } from "node:crypto";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  CreateRepositoryAcceptedResponseSchema,
  CreateRepositoryRequestSchema,
  RepositoryResponseSchema,
  SearchHitSchema,
  SearchRequestSchema,
  SearchResultSchema,
} from "@rag/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { registerMcpRoutes } from "./mcp/mcp-server.js";
import { type ApiDependencies, executeHybridSearch } from "./services/search-orchestrator.js";

export function buildApp(deps: ApiDependencies): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Hybrid RAG & MCP Engine API",
        description: "CQRS API + Model Context Protocol server for hybrid code/docs search",
        version: "0.1.0",
      },
    },
    transform: jsonSchemaTransform,
  });

  app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/healthz",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok") }),
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  typed.get(
    "/readyz",
    {
      schema: {
        response: {
          200: z.object({
            status: z.literal("ready"),
            dependencies: z.record(z.string(), z.boolean()),
          }),
          503: z.object({
            status: z.literal("degraded"),
            dependencies: z.record(z.string(), z.boolean()),
          }),
        },
      },
    },
    async (_request, reply) => {
      const check = async (fn: () => Promise<boolean>): Promise<boolean> => {
        try {
          return await fn();
        } catch {
          return false;
        }
      };

      const [postgres, redis, elasticsearch, kafka] = await Promise.all([
        check(() => deps.dbRepo.ping()),
        check(() => deps.cacheService.ping()),
        check(() => deps.searchService.ping()),
        check(() => deps.eventsService.ping()),
      ]);

      const dependencies = { postgres, redis, elasticsearch, kafka };
      const allReady = postgres && redis && elasticsearch && kafka;

      if (!allReady) {
        return reply.status(503).send({
          status: "degraded",
          dependencies,
        });
      }

      return reply.status(200).send({
        status: "ready",
        dependencies,
      });
    },
  );

  typed.post(
    "/api/v1/repositories",
    {
      schema: {
        body: CreateRepositoryRequestSchema,
        response: {
          202: CreateRepositoryAcceptedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { repository, job } = await deps.dbRepo.createRepositoryWithJob(request.body);

      await deps.eventsService.publishIngestionRequested({
        jobId: job.id || randomUUID(),
        repositoryId: repository.id,
        repositoryUrl: repository.url,
        branch: repository.defaultBranch,
        requestedAt: new Date().toISOString(),
      });

      return reply.status(202).send({
        repositoryId: repository.id,
        jobId: job.id,
        status: job.status,
      });
    },
  );

  typed.get(
    "/api/v1/repositories",
    {
      schema: {
        response: {
          200: z.object({
            repositories: z.array(RepositoryResponseSchema),
          }),
        },
      },
    },
    async () => {
      const repositories = await deps.dbRepo.listRepositories();
      return { repositories };
    },
  );

  typed.post(
    "/api/v1/search",
    {
      schema: {
        body: SearchRequestSchema,
        response: {
          200: SearchResultSchema,
        },
      },
    },
    async (request) => {
      return executeHybridSearch(request.body, deps);
    },
  );

  typed.get(
    "/api/v1/symbols",
    {
      schema: {
        querystring: z.object({
          symbolName: z.string().min(1),
          repositoryName: z.string().min(1).optional(),
        }),
        response: {
          200: z.object({
            symbolName: z.string(),
            total: z.number().int().min(0),
            definitions: z.array(SearchHitSchema),
          }),
        },
      },
    },
    async (request) => {
      const definitions = await deps.searchService.getSymbolDefinition(
        request.query.symbolName,
        request.query.repositoryName,
      );
      return {
        symbolName: request.query.symbolName,
        total: definitions.length,
        definitions,
      };
    },
  );

  typed.delete(
    "/api/v1/repositories/:id",
    {
      schema: {
        params: z.object({
          id: z.string().uuid(),
        }),
        response: {
          200: z.object({
            deleted: z.literal(true),
            id: z.string().uuid(),
            deletedChunks: z.number().int().min(0),
          }),
          404: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const deleted = await deps.dbRepo.deleteRepository(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "Repository not found" });
      }
      const deletedChunks = await deps.searchService.deleteRepositoryChunks(request.params.id);
      await deps.cacheService.invalidateRepoCache(request.params.id);
      return reply.status(200).send({
        deleted: true,
        id: request.params.id,
        deletedChunks,
      });
    },
  );

  registerMcpRoutes(app, deps);

  return app;
}
