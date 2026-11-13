import { z } from "zod";

export const KAFKA_TOPICS = {
  INGESTION_REQUESTED: "docs.ingestion.requested",
  INGESTION_DLQ: "docs.ingestion.dlq",
} as const;

export const KAFKA_CONSUMER_GROUP = "rag-ingestion-workers" as const;

/**
 * Event emitted by apps/api when a repository ingestion job is queued.
 */
export const IngestionRequestedEventSchema = z.object({
  jobId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  repositoryUrl: z.string().min(1),
  branch: z.string().min(1).default("main"),
  requestedAt: z.string().datetime(),
});

export type IngestionRequestedEvent = z.infer<typeof IngestionRequestedEventSchema>;

/**
 * Dead Letter Topic payload published after exhausting retries on ingestion.
 */
export const IngestionDlqEventSchema = z.object({
  originalEvent: IngestionRequestedEventSchema,
  errorMessage: z.string(),
  attempts: z.number().int().min(1),
  failedAt: z.string().datetime(),
});

export type IngestionDlqEvent = z.infer<typeof IngestionDlqEventSchema>;
