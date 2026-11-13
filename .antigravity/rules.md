# System Rules & Coding Standards — Hybrid RAG & MCP Engine

## 1. Objetivo del Proyecto

Arquitectura y estándares de código del **Motor de Búsqueda Híbrida (RAG) y Servidor MCP (Model Context Protocol)** construido sobre un monorepo **Node.js 22 + TypeScript 5**.
El sistema ingesta repositorios de código y documentación técnica de forma asíncrona, los indexa de manera híbrida (léxica + vectorial) y los expone mediante REST (`apps/api`), consola web (`apps/web`) y protocolo MCP para clientes compatibles e IDEs.

## 2. Restricción Estricta de IA (CRÍTICO)

- **PROHIBIDO** instalar o importar SDKs de LLMs externos (`@google/genai`, `openai`, `anthropic`, `langchain`, `llamaindex`, etc.).
- El razonamiento y generación de texto ocurren **exclusivamente** en el cliente (Antigravity IDE).
- El backend solo ejecuta:
  1. Generación de embeddings locales en CPU vía `@huggingface/transformers` (ONNX).
  2. Búsqueda híbrida (BM25 + kNN vectorial con RRF) en Elasticsearch.
  3. Exposición de herramientas vía `@modelcontextprotocol/sdk`.

## 3. Stack Tecnológico Obligatorio

- **Monorepo:** `pnpm` workspaces + `Turborepo`.
- **Runtime & Lenguaje:** Node.js 22 LTS (ESM `"type": "module"`), TypeScript 5 (`strict: true`, `noUncheckedIndexedAccess: true`).
- **Linter & Formatter:** `@biomejs/biome` (No usar ESLint ni Prettier).
- **API Framework:** `Fastify` v5 + `fastify-type-provider-zod` + `zod`.
- **Servidor MCP:** `@modelcontextprotocol/sdk` (Transporte Streamable HTTP / SSE integrado en Fastify).
- **Write Model (Fuente de la verdad):** `PostgreSQL 17` + `drizzle-orm` + `postgres` (driver).
- **Bus de Eventos:** `Apache Kafka` (modo KRaft sin Zookeeper) + `kafkajs`.
- **Read Model (Búsqueda Híbrida):** `Elasticsearch 8.15+` + `@elastic/elasticsearch`.
- **Caché & Rate Limiting:** `Redis 7` + `ioredis`.
- **AST Code Chunking:** `web-tree-sitter` (WebAssembly) + `pdf-parse`.
- **Embeddings Locales:** `@huggingface/transformers` (Modelo por defecto: `Xenova/bge-base-en-v1.5`, 768 dimensiones).
- **Testing:** `Vitest` + `@testcontainers/postgresql` + `@testcontainers/kafka` + `@testcontainers/elasticsearch` + `@testcontainers/redis`.

## 4. Reglas de Arquitectura y Código

1. **Separación CQRS y Persistencia Políglota:**
   - Todo cambio de estado transaccional (alta de repositorio, estado de indexación, historial de commits) se guarda en **PostgreSQL**.
   - El trabajo pesado (clonar repo, parsear AST, generar embeddings) se delega a `apps/worker` publicando un evento en **Kafka**.
   - Los fragmentos indexados (`chunks`) viven en **Elasticsearch**.
   - Las respuestas de búsqueda se cachean en **Redis** con invalidación por `repositoryId`.
2. **Validación de Contratos:** Todo payload HTTP, mensaje de Kafka, variable de entorno y argumento MCP debe validarse con esquemas **Zod** ubicados en `packages/shared-types`.
3. **Resiliencia:**
   - El consumidor de Kafka debe ser idempotente (usar un hash determinista `sha256(repoId + filePath + startLine + commitHash)` como `_id` en Elasticsearch).
   - Implementar reintentos con _exponential backoff_ y envío a Dead Letter Topic (`docs.ingestion.dlq`) tras 3 fallos.
4. **Calidad antes de completar una tarea:**
   - Antes de dar por terminada cualquier fase, verifica que `pnpm turbo typecheck`, `pnpm turbo lint` y `pnpm turbo test` pasen sin errores.
