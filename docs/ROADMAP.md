# Roadmap de Implementación del Proyecto

Registro progresivo de las fases técnicas completadas en el monorepo, junto con los criterios de verificación empleados en cada etapa.

---

## Fase 1: Inicialización del Monorepo e Infraestructura Local

- [x] Crear `package.json` raíz, `pnpm-workspace.yaml`, `turbo.json`, `biome.json` y `packages/tsconfig`.
- [x] Crear `packages/shared-types` con los esquemas Zod de configuración de entorno, eventos de Kafka, DTOs de la API y argumentos MCP.
- [x] Crear `docker-compose.yml` con:
  - `postgres`: imagen `postgres:17-alpine` (puerto 5432, healthcheck `pg_isready`).
  - `redis`: imagen `redis:7-alpine` (puerto 6379, healthcheck `redis-cli ping`).
  - `kafka`: imagen `apache/kafka:3.8.0` configurada en modo **KRaft** (sin Zookeeper, puerto 9092).
  - `elasticsearch`: imagen `docker.elastic.co/elasticsearch/elasticsearch:8.15.0` (`single-node`, `xpack.security.enabled=false`, límite de memoria 1GB, puerto 9200).
- **Verificación:** `pnpm install && pnpm turbo typecheck lint` pasa sin errores.

---

## Fase 2: Paquetes de Datos (`db`, `cache`, `search`, `events`)

- [x] **`packages/db`**: Configurar Drizzle ORM, definir esquemas `repositories` e `ingestion_jobs`, scripts de migración (`drizzle-kit`) y repositorio CRUD.
- [x] **`packages/cache`**: Implementar cliente `ioredis` con métodos `getOrSet(key, ttl, fetcher)` e `invalidateRepoCache(repoId)`.
- [x] **`packages/search`**: Implementar cliente `@elastic/elasticsearch`, función `ensureIndex()` con el mapping de 768 dimensiones y método `hybridSearch()` combinando BM25 + kNN.
- [x] **`packages/events`**: Implementar productor y consumidor tipados con `kafkajs`, incluyendo manejo automático de reintentos y desvío a `docs.ingestion.dlq`.
- **Verificación:** Crear tests unitarios en cada paquete y validar con `pnpm turbo test`.

---

## Fase 3: Motor de Embeddings Locales y AST Chunking (`packages/embeddings` & `apps/worker`)

- [x] **`packages/embeddings`**: Implementar clase Singleton usando `@huggingface/transformers` (`pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5', { quantized: true })`) que normalice vectores de 768 dimensiones.
- [x] **`apps/worker`**:
  - Implementar parser AST con `web-tree-sitter` (soportando TypeScript/JavaScript, Python, Go) y fallback por bloques semánticos para Markdown/PDF.
  - Implementar el consumidor de Kafka (`docs.ingestion.requested`) que:
    1. Actualiza el job en PostgreSQL a `PROCESSING`.
    2. Clona el repositorio de forma superficial (`git clone --depth 1`) o lee un directorio local.
    3. Trocea el código en funciones/clases conservando `startLine` y `endLine`.
    4. Genera embeddings en lotes (_batches_) y hace _bulk index_ idempotente en Elasticsearch.
    5. Invalida la caché de Redis del repositorio y marca el job como `COMPLETED` en PostgreSQL.
- **Verificación:** Test unitario del chunker AST verificando que extrae correctamente funciones con su número de línea de inicio y fin.

---

## Fase 4: Servidor Fastify REST + Servidor MCP (`apps/api`)

- [x] Configurar Fastify con `fastify-type-provider-zod`, Swagger/OpenAPI y endpoints de salud (`/healthz` liveness y `/readyz` verificando conexión a PG, Redis, Elastic y Kafka).
- [x] Endpoints REST:
  - `POST /api/v1/repositories`: Registra el repositorio en PostgreSQL y publica evento en Kafka (`202 Accepted`).
  - `GET /api/v1/repositories`: Lista repositorios y el estado de sus jobs.
  - `POST /api/v1/search`: Endpoint REST de búsqueda híbrida.
- [x] Endpoint MCP (`/mcp`):
  - Integrar `@modelcontextprotocol/sdk` registrando las herramientas `search_technical_docs`, `get_symbol_definition` y `list_indexed_repositories`.
- **Verificación:** `pnpm turbo build typecheck test`.

---

## Fase 5: Suite de Tests de Integración con Testcontainers

- [x] Configurar `vitest.workspace.ts` separando `unit` e `integration`.
- [x] Crear test de integración _end-to-end_ usando `@testcontainers/postgresql`, `@testcontainers/redis`, `@testcontainers/kafka` y `@testcontainers/elasticsearch` (con un _mock_ rápido o modelo ligero para embeddings en CI):
  1. Enviar `POST /api/v1/repositories`.
  2. Verificar que el mensaje pasa por Kafka y el worker indexa los chunks en Elasticsearch.
  3. Invocar la herramienta MCP `search_technical_docs` y comprobar que devuelve el fragmento exacto con sus líneas de código y que la segunda llamada golpea la caché de Redis.

---

## Fase 6: Contenerización Optimizada con `turbo prune`

- [x] Crear `Dockerfile.api` y `Dockerfile.worker` multi-stage:
  - Stage 1 (`pruner`): ejecuta `npx turbo prune --scope=@rag/api --docker`.
  - Stage 2 (`installer`): instala dependencias con `pnpm install --frozen-lockfile` y compila TypeScript.
  - Stage 3 (`runner`): imagen `node:22-slim`, usuario `node` sin privilegios `root`, pre-descarga del modelo ONNX de embeddings para arranque en frío instantáneo.

---

## Fase 7: Manifiestos de Kubernetes (`k8s/`)

- [x] Crear manifiestos base con Kustomize (`k8s/base/`):
  - `Deployment` y `Service` para `api` con `livenessProbe`, `readinessProbe` y `HorizontalPodAutoscaler` (HPA).
  - `Deployment` y `HPA` para `worker`.
  - `StatefulSet` y `PersistentVolumeClaim` para PostgreSQL, Redis, Elasticsearch y Kafka KRaft.
  - `ConfigMap` y `Secret` de ejemplo.

---

## Fase 8: CI/CD en GitHub Actions y Documentación para Entrevistas

- [x] Crear `.github/workflows/ci.yml`:
  - Job 1: `pnpm turbo lint typecheck` + Tests unitarios.
  - Job 2: Tests de integración con Testcontainers.
  - Job 3: Build de imágenes Docker + escaneo de seguridad con **Trivy**.
  - Job 4: Clúster efímero con **Kind (Kubernetes in Docker)**, despliegue de manifiestos y smoke test contra `/healthz`.
- [x] Crear `.github/workflows/cd.yml`: Publicación automática de `api` y `worker` en `ghcr.io`.
- [x] Redactar `README.md` profesional con diagramas de arquitectura, explicación de decisiones técnicas (CQRS, RRF, KRaft, MCP) y guía de inicio rápido.

---

## Fase 9: Consola Web Interactiva (`apps/web`) y Extensiones REST

- [x] Añadir endpoints REST complementarios en `apps/api`: `GET /api/v1/symbols`, `DELETE /api/v1/repositories/:id` (con limpieza en Elasticsearch, Redis y PostgreSQL) y `@fastify/cors`.
- [x] Construir consola web en React 19 + Vite + TypeScript + Tailwind CSS v4 (`apps/web`):
  - Barra de estado en tiempo real de PostgreSQL, Redis, Elasticsearch y Kafka (`/readyz`).
  - Playground de búsqueda híbrida (`BM25 + kNN / RRF`) y búsqueda exacta de símbolos con indicadores de latencia y Redis Cache Hit/Miss.
  - Panel de gestión de repositorios y jobs de ingesta con alta, re-indexación y eliminación.
- **Verificación:** `pnpm turbo build typecheck lint && pnpm test:unit`.
