import type {
  CreateRepositoryRequest,
  IngestionJobResponse,
  RepositoryResponse,
} from "@rag/shared-types";
import { desc, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { type DatabaseClient, ensureDatabaseSchema } from "./client.js";
import { type IngestionJobRow, ingestionJobs, type RepositoryRow, repositories } from "./schema.js";

function mapJob(row: IngestionJobRow): IngestionJobResponse {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    commitHash: row.commitHash,
    status: row.status,
    totalChunks: row.totalChunks,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function mapRepository(row: RepositoryRow, latestJob?: IngestionJobRow | null): RepositoryResponse {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    defaultBranch: row.defaultBranch,
    status: row.status,
    lastIndexedCommit: row.lastIndexedCommit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestJob: latestJob ? mapJob(latestJob) : null,
  };
}

export class IngestionDatabaseRepository {
  constructor(
    private readonly db: DatabaseClient,
    private readonly sql: Sql,
  ) {}

  async initSchema(): Promise<void> {
    await ensureDatabaseSchema(this.sql);
  }

  async createRepositoryWithJob(
    input: CreateRepositoryRequest,
  ): Promise<{ repository: RepositoryResponse; job: IngestionJobResponse }> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [existing] = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.url, input.url))
        .limit(1);

      let repoRow: RepositoryRow;
      if (existing) {
        const [updated] = await tx
          .update(repositories)
          .set({
            name: input.name,
            defaultBranch: input.defaultBranch,
            status: "PENDING",
            updatedAt: now,
          })
          .where(eq(repositories.id, existing.id))
          .returning();
        if (!updated) {
          throw new Error("Failed to update existing repository");
        }
        repoRow = updated;
      } else {
        const [inserted] = await tx
          .insert(repositories)
          .values({
            name: input.name,
            url: input.url,
            defaultBranch: input.defaultBranch,
            status: "PENDING",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!inserted) {
          throw new Error("Failed to insert repository");
        }
        repoRow = inserted;
      }

      const [jobRow] = await tx
        .insert(ingestionJobs)
        .values({
          repositoryId: repoRow.id,
          status: "QUEUED",
          totalChunks: 0,
        })
        .returning();

      if (!jobRow) {
        throw new Error("Failed to insert ingestion job");
      }

      return {
        repository: mapRepository(repoRow, jobRow),
        job: mapJob(jobRow),
      };
    });
  }

  async listRepositories(): Promise<RepositoryResponse[]> {
    const repos = await this.db.select().from(repositories).orderBy(desc(repositories.createdAt));
    const jobs = await this.db.select().from(ingestionJobs);

    const latestJobByRepo = new Map<string, IngestionJobRow>();
    for (const job of jobs) {
      const prev = latestJobByRepo.get(job.repositoryId);
      if (!prev) {
        latestJobByRepo.set(job.repositoryId, job);
      } else {
        const prevTime = prev.startedAt?.getTime() ?? 0;
        const currTime = job.startedAt?.getTime() ?? 0;
        if (currTime >= prevTime) {
          latestJobByRepo.set(job.repositoryId, job);
        }
      }
    }

    return repos.map((repo) => mapRepository(repo, latestJobByRepo.get(repo.id) ?? null));
  }

  async listReadyRepositories(): Promise<RepositoryResponse[]> {
    const repos = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.status, "READY"))
      .orderBy(desc(repositories.updatedAt));

    return repos.map((repo) => mapRepository(repo));
  }

  async getRepositoryById(repositoryId: string): Promise<RepositoryResponse | null> {
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);

    if (!repo) {
      return null;
    }

    const [latestJob] = await this.db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.repositoryId, repositoryId))
      .orderBy(desc(ingestionJobs.startedAt))
      .limit(1);

    return mapRepository(repo, latestJob ?? null);
  }

  async markJobProcessing(jobId: string, repositoryId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(ingestionJobs)
        .set({ status: "PROCESSING", startedAt: now, errorMessage: null })
        .where(eq(ingestionJobs.id, jobId));
      await tx
        .update(repositories)
        .set({ status: "INDEXING", updatedAt: now })
        .where(eq(repositories.id, repositoryId));
    });
  }

  async markJobCompleted(
    jobId: string,
    repositoryId: string,
    commitHash: string,
    totalChunks: number,
  ): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(ingestionJobs)
        .set({
          status: "COMPLETED",
          commitHash,
          totalChunks,
          completedAt: now,
          errorMessage: null,
        })
        .where(eq(ingestionJobs.id, jobId));
      await tx
        .update(repositories)
        .set({
          status: "READY",
          lastIndexedCommit: commitHash,
          updatedAt: now,
        })
        .where(eq(repositories.id, repositoryId));
    });
  }

  async markJobFailed(jobId: string, repositoryId: string, errorMessage: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(ingestionJobs)
        .set({
          status: "FAILED",
          errorMessage,
          completedAt: now,
        })
        .where(eq(ingestionJobs.id, jobId));
      await tx
        .update(repositories)
        .set({
          status: "FAILED",
          updatedAt: now,
        })
        .where(eq(repositories.id, repositoryId));
    });
  }

  async deleteRepository(repositoryId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(repositories)
      .where(eq(repositories.id, repositoryId))
      .returning({ id: repositories.id });
    return deleted.length > 0;
  }

  async ping(): Promise<boolean> {
    await this.sql`SELECT 1`;
    return true;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
