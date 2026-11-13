import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { RedisCacheService } from "@rag/cache";
import type { IngestionDatabaseRepository } from "@rag/db";
import type { LocalEmbeddingsEngine } from "@rag/embeddings";
import {
  computeDeterministicChunkId,
  type ElasticSearchService,
  type IndexedChunkDocument,
} from "@rag/search";
import type { IngestionRequestedEvent } from "@rag/shared-types";
import { AstChunker, detectLanguageFromPath, type ExtractedChunk } from "./chunker/ast-chunker.js";

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".turbo", "coverage", ".next"]);

export interface IngestionWorkerDeps {
  dbRepo: Pick<
    IngestionDatabaseRepository,
    "getRepositoryById" | "markJobProcessing" | "markJobCompleted" | "markJobFailed"
  >;
  searchService: Pick<ElasticSearchService, "ensureIndex" | "bulkIndexChunks">;
  cacheService: Pick<RedisCacheService, "invalidateRepoCache">;
  embeddingsEngine: Pick<LocalEmbeddingsEngine, "embedBatch">;
  chunker?: AstChunker;
}

async function collectSupportedFiles(rootDir: string): Promise<string[]> {
  const collected: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && detectLanguageFromPath(fullPath) !== null) {
        collected.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return collected.sort();
}

async function resolveRepositorySource(
  repositoryUrl: string,
  branch: string,
): Promise<{ workDir: string; commitHash: string; cleanup: () => Promise<void> }> {
  const normalizedPath = repositoryUrl.startsWith("file://")
    ? repositoryUrl.slice("file://".length)
    : repositoryUrl;

  // If it's a local non-bare directory without .git, read directly; if it has .git or is remote, clone it.
  if (existsSync(normalizedPath)) {
    const stats = await stat(normalizedPath);
    if (stats.isDirectory() && !existsSync(join(normalizedPath, ".git"))) {
      return {
        workDir: normalizedPath,
        commitHash: "local-workspace",
        cleanup: async () => {},
      };
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), "hybrid-rag-clone-"));
  try {
    await execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      branch,
      repositoryUrl,
      tempDir,
    ]);
    const { stdout } = await execFileAsync("git", ["-C", tempDir, "rev-parse", "HEAD"]);
    return {
      workDir: tempDir,
      commitHash: stdout.trim(),
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function processIngestionEvent(
  event: IngestionRequestedEvent,
  deps: IngestionWorkerDeps,
): Promise<{ totalChunks: number; commitHash: string }> {
  const chunker = deps.chunker ?? new AstChunker();
  await deps.dbRepo.markJobProcessing(event.jobId, event.repositoryId);

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const repoInfo = await deps.dbRepo.getRepositoryById(event.repositoryId);
    const repositoryName = repoInfo?.name ?? event.repositoryUrl;

    const source = await resolveRepositorySource(event.repositoryUrl, event.branch);
    cleanup = source.cleanup;

    const files = await collectSupportedFiles(source.workDir);
    const extracted: ExtractedChunk[] = [];

    for (const absPath of files) {
      const relPath = relative(source.workDir, absPath).replace(/\\/g, "/");
      const raw = await readFile(absPath);
      const chunks = await chunker.chunkFile(relPath, raw);
      extracted.push(...chunks);
    }

    await deps.searchService.ensureIndex();

    if (extracted.length > 0) {
      const embeddings = await deps.embeddingsEngine.embedBatch(
        extracted.map((c) => `${c.symbolName}\n${c.filePath}\n${c.content}`),
      );

      const documents: IndexedChunkDocument[] = extracted.map((chunk, idx) => ({
        chunkId: computeDeterministicChunkId(
          event.repositoryId,
          chunk.filePath,
          chunk.startLine,
          source.commitHash,
        ),
        repositoryId: event.repositoryId,
        repositoryName,
        filePath: chunk.filePath,
        language: chunk.language,
        symbolName: chunk.symbolName,
        symbolType: chunk.symbolType,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        commitHash: source.commitHash,
        embedding: embeddings[idx] ?? [],
      }));

      await deps.searchService.bulkIndexChunks(documents);
    }

    await deps.cacheService.invalidateRepoCache(event.repositoryId);
    await deps.dbRepo.markJobCompleted(
      event.jobId,
      event.repositoryId,
      source.commitHash,
      extracted.length,
    );

    return {
      totalChunks: extracted.length,
      commitHash: source.commitHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.dbRepo.markJobFailed(event.jobId, event.repositoryId, message);
    throw error;
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
}
