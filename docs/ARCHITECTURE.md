# Especificación de Arquitectura y Contratos de Datos

## 1. Estructura del Monorepo

```text
hybrid-rag-monorepo/
├── .antigravity/
│   ├── rules.md
│   └── mcp.json
├── .github/workflows/
│   ├── ci.yml
│   └── cd.yml
├── apps/
│   ├── api/                  # Fastify REST API + Servidor MCP (/mcp)
│   ├── web/                  # Consola Web Interactiva (React 19 + Vite + Tailwind CSS v4)
│   └── worker/               # Consumidor Kafka + AST Chunking + Indexador Elastic
├── packages/
│   ├── shared-types/         # Esquemas Zod (DTOs, Env, Eventos Kafka, MCP Tools)
│   ├── db/                   # Drizzle ORM (PostgreSQL 17)
│   ├── events/               # Cliente KafkaJS (Producer, Consumer, DLQ handler)
│   ├── search/               # Cliente Elasticsearch (Mapping híbrido + RRF queries)
│   ├── cache/                # Cliente Redis (Cache-Aside + invalidación por prefijo)
│   ├── embeddings/           # Singleton ONNX local (@huggingface/transformers)
│   └── tsconfig/             # Configuraciones base TS
├── k8s/
│   ├── base/                 # Manifiestos K8s (API, Worker, StatefulSets, HPA)
│   └── overlays/             # Kustomize (dev, prod)
├── docker-compose.yml
├── Dockerfile.api
├── Dockerfile.worker
├── biome.json
├── turbo.json
└── pnpm-workspace.yaml
```

## 2. Modelo Relacional en PostgreSQL (`packages/db`)

Esquema gestionado con **Drizzle ORM**:

### Tabla `repositories`

- `id`: `uuid` (PK, default `gen_random_uuid()`)
- `name`: `varchar(255)` (NOT NULL)
- `url`: `varchar(512)` (UNIQUE, NOT NULL)
- `defaultBranch`: `varchar(100)` (default `'main'`)
- `status`: `enum('PENDING', 'INDEXING', 'READY', 'FAILED')`
- `lastIndexedCommit`: `varchar(64)` (nullable)
- `createdAt`: `timestamp`
- `updatedAt`: `timestamp`

### Tabla `ingestion_jobs`

- `id`: `uuid` (PK)
- `repositoryId`: `uuid` (FK -> `repositories.id` ON DELETE CASCADE)
- `commitHash`: `varchar(64)`
- `status`: `enum('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')`
- `totalChunks`: `integer` (default 0)
- `errorMessage`: `text` (nullable)
- `startedAt`: `timestamp`
- `completedAt`: `timestamp`

## 3. Contratos de Eventos en Kafka (`packages/events`)

- **Topic Principal:** `docs.ingestion.requested` (3 particiones)
- **Dead Letter Topic:** `docs.ingestion.dlq` (1 partición)
- **Consumer Group:** `rag-ingestion-workers`

**Payload Zod (`IngestionRequestedEventSchema`):**

```json
{
  "jobId": "uuid-v4",
  "repositoryId": "uuid-v4",
  "repositoryUrl": "https://github.com/org/repo.git",
  "branch": "main",
  "requestedAt": "2026-11-13T12:00:00Z"
}
```

## 4. Índice Híbrido en Elasticsearch (`packages/search`)

- **Nombre del Índice:** `code_and_docs_chunks`
- **Mapping:**
  - `chunkId`: `keyword` (Hash determinista para idempotencia)
  - `repositoryId`: `keyword`
  - `repositoryName`: `keyword`
  - `filePath`: `keyword`
  - `language`: `keyword`
  - `symbolName`: `text` (con subcampo `.keyword` para búsqueda exacta)
  - `symbolType`: `keyword` (`function`, `class`, `interface`, `markdown_section`)
  - `content`: `text` (analizador estándar + analizador de código para camelCase/snake_case)
  - `startLine`: `integer`
  - `endLine`: `integer`
  - `commitHash`: `keyword`
  - `embedding`: `dense_vector` (`dims: 768`, `index: true`, `similarity: "cosine"`, `index_options: { type: "hnsw", m: 16, ef_construction: 100 }`)

- **Estrategia de Consulta Híbrida:**
  Combinar una query `multi_match` (sobre `content`, `symbolName^3`, `filePath^2`) y una búsqueda `knn` (sobre `embedding`) unificadas mediante un retriever **RRF (Reciprocal Rank Fusion)** (`rank_window_size: 50`, `rank_constant: 60`) o combinación ponderada en caso de licencia Basic de Elasticsearch.

## 5. Herramientas del Servidor MCP (`apps/api`)

Herramientas expuestas en el endpoint `/mcp` mediante `@modelcontextprotocol/sdk`:

1. **`search_technical_docs`**
   - _Input:_ `{ query: string, repositoryName?: string, language?: string, topK?: number (default 8) }`
   - _Flujo:_ Comprueba caché en Redis (`search:{hash(input)}`) -> Si no existe, genera embedding local de `query` -> Ejecuta búsqueda híbrida en Elasticsearch -> Guarda en Redis (TTL 10 min) -> Devuelve fragmentos con ruta de archivo y líneas exactas.
2. **`get_symbol_definition`**
   - _Input:_ `{ symbolName: string, repositoryName?: string }`
   - _Flujo:_ Búsqueda léxica exacta sobre `symbolName.keyword` en Elasticsearch.
3. **`list_indexed_repositories`**
   - _Input:_ `{}`
   - _Flujo:_ Consulta PostgreSQL y devuelve la lista de repositorios en estado `READY` y su último commit.
