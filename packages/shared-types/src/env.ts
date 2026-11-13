import { z } from "zod";

/**
 * Validated runtime environment configuration shared across API and Worker services.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/hybrid_rag"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  KAFKA_BROKERS: z.string().min(1).default("localhost:9092"),
  KAFKA_CLIENT_ID: z.string().min(1).default("hybrid-rag-engine"),
  ELASTICSEARCH_NODE: z.string().url().default("http://localhost:9200"),
  ELASTICSEARCH_USE_NATIVE_RRF: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  EMBEDDINGS_MODEL: z.string().min(1).default("Xenova/bge-base-en-v1.5"),
  EMBEDDINGS_MOCK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Parses and validates environment variables against EnvSchema.
 */
export function parseEnv(rawEnv: Record<string, string | undefined> = process.env): EnvConfig {
  return EnvSchema.parse(rawEnv);
}
