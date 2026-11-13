import { integer, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const repositoryStatusEnum = pgEnum("repository_status", [
  "PENDING",
  "INDEXING",
  "READY",
  "FAILED",
]);

export const jobStatusEnum = pgEnum("job_status", ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"]);

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 512 }).notNull().unique(),
  defaultBranch: varchar("default_branch", { length: 100 }).notNull().default("main"),
  status: repositoryStatusEnum("status").notNull().default("PENDING"),
  lastIndexedCommit: varchar("last_indexed_commit", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  commitHash: varchar("commit_hash", { length: 64 }),
  status: jobStatusEnum("status").notNull().default("QUEUED"),
  totalChunks: integer("total_chunks").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
export type IngestionJobRow = typeof ingestionJobs.$inferSelect;
export type NewIngestionJobRow = typeof ingestionJobs.$inferInsert;
