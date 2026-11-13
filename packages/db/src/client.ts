import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type DatabaseClient = PostgresJsDatabase<typeof schema>;

export interface DatabaseConnection {
  sql: Sql;
  db: DatabaseClient;
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

/**
 * Idempotently creates enums and tables if they do not exist yet.
 */
export async function ensureDatabaseSchema(sql: Sql): Promise<void> {
  await sql`
    DO $$ BEGIN
      CREATE TYPE repository_status AS ENUM ('PENDING', 'INDEXING', 'READY', 'FAILED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  await sql`
    DO $$ BEGIN
      CREATE TYPE job_status AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS repositories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(255) NOT NULL,
      url varchar(512) NOT NULL UNIQUE,
      default_branch varchar(100) NOT NULL DEFAULT 'main',
      status repository_status NOT NULL DEFAULT 'PENDING',
      last_indexed_commit varchar(64),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      commit_hash varchar(64),
      status job_status NOT NULL DEFAULT 'QUEUED',
      total_chunks integer NOT NULL DEFAULT 0,
      error_message text,
      started_at timestamptz,
      completed_at timestamptz
    );
  `;
}
