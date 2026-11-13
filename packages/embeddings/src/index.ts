import { createHash } from "node:crypto";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-base-en-v1.5";
export const EMBEDDING_DIMS = 768;

export interface EmbeddingsEngineOptions {
  model?: string;
  quantized?: boolean;
  mock?: boolean;
}

/**
 * Normalizes a vector to unit L2 norm.
 */
export function normalizeVectorL2(vector: number[]): number[] {
  let sumSq = 0;
  for (const val of vector) {
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    return vector.map((_, idx) => (idx === 0 ? 1 : 0));
  }
  return vector.map((val) => val / norm);
}

/**
 * Deterministic 768-d embedding generator for fast unit/integration tests without network downloads.
 */
export function createDeterministicEmbedding(text: string, dims = EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    vec[0] = 1;
    return vec;
  }

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const bucketA = digest.readUInt16BE(0) % dims;
    const bucketB = digest.readUInt16BE(2) % dims;
    const signA = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
    const signB = (digest[5] ?? 0) % 2 === 0 ? 1 : -1;
    vec[bucketA] = (vec[bucketA] ?? 0) + signA;
    vec[bucketB] = (vec[bucketB] ?? 0) + signB * 0.5;
  }

  return normalizeVectorL2(vec);
}

/**
 * Singleton local ONNX embedding engine using @huggingface/transformers.
 */
export class LocalEmbeddingsEngine {
  private static instance: LocalEmbeddingsEngine | null = null;

  private extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
  private readonly model: string;
  private readonly quantized: boolean;
  private readonly mock: boolean;

  private constructor(options: EmbeddingsEngineOptions = {}) {
    this.model = options.model ?? process.env.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.quantized = options.quantized ?? true;
    this.mock = options.mock ?? process.env.EMBEDDINGS_MOCK === "true";
  }

  static getInstance(options?: EmbeddingsEngineOptions): LocalEmbeddingsEngine {
    if (!LocalEmbeddingsEngine.instance) {
      LocalEmbeddingsEngine.instance = new LocalEmbeddingsEngine(options);
    }
    return LocalEmbeddingsEngine.instance;
  }

  static resetInstanceForTesting(): void {
    LocalEmbeddingsEngine.instance = null;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractorPromise) {
      this.extractorPromise = pipeline("feature-extraction", this.model, {
        dtype: this.quantized ? "q8" : "fp32",
      }) as Promise<FeatureExtractionPipeline>;
    }
    return this.extractorPromise;
  }

  async embedText(text: string): Promise<number[]> {
    if (this.mock) {
      return createDeterministicEmbedding(text, EMBEDDING_DIMS);
    }

    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const raw = Array.from(output.data as Float32Array);

    if (raw.length !== EMBEDDING_DIMS) {
      throw new Error(`Expected ${EMBEDDING_DIMS} embedding dimensions, got ${raw.length}`);
    }

    return normalizeVectorL2(raw);
  }

  async embedBatch(texts: string[], batchSize = 16): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      for (const text of slice) {
        results.push(await this.embedText(text));
        // Yield to Node event loop so Kafka heartbeats and health checks stay responsive during CPU ONNX inference
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return results;
  }
}
