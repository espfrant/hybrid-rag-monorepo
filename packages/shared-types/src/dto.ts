import { z } from "zod";

export const RepositoryStatusSchema = z.enum(["PENDING", "INDEXING", "READY", "FAILED"]);
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;

export const JobStatusSchema = z.enum(["QUEUED", "PROCESSING", "COMPLETED", "FAILED"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const SymbolTypeSchema = z.enum(["function", "class", "interface", "markdown_section"]);
export type SymbolType = z.infer<typeof SymbolTypeSchema>;

export const CreateRepositoryRequestSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().min(1).max(512),
  defaultBranch: z.string().min(1).max(100).default("main"),
});
export type CreateRepositoryRequest = z.infer<typeof CreateRepositoryRequestSchema>;

export const IngestionJobResponseSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  commitHash: z.string().nullable(),
  status: JobStatusSchema,
  totalChunks: z.number().int(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type IngestionJobResponse = z.infer<typeof IngestionJobResponseSchema>;

export const RepositoryResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
  status: RepositoryStatusSchema,
  lastIndexedCommit: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  latestJob: IngestionJobResponseSchema.nullable().optional(),
});
export type RepositoryResponse = z.infer<typeof RepositoryResponseSchema>;

export const CreateRepositoryAcceptedResponseSchema = z.object({
  repositoryId: z.string().uuid(),
  jobId: z.string().uuid(),
  status: JobStatusSchema,
});
export type CreateRepositoryAcceptedResponse = z.infer<
  typeof CreateRepositoryAcceptedResponseSchema
>;

export const DocumentChunkSchema = z.object({
  chunkId: z.string().min(1),
  repositoryId: z.string().uuid(),
  repositoryName: z.string().min(1),
  filePath: z.string().min(1),
  language: z.string().min(1),
  symbolName: z.string().min(1),
  symbolType: SymbolTypeSchema,
  content: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  commitHash: z.string().min(1),
});
export type DocumentChunk = z.infer<typeof DocumentChunkSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  repositoryName: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  topK: z.number().int().min(1).max(50).default(8),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = DocumentChunkSchema.extend({
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  query: z.string(),
  cached: z.boolean(),
  total: z.number().int().min(0),
  results: z.array(SearchHitSchema),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
