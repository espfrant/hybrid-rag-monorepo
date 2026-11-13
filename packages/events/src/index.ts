import {
  type IngestionDlqEvent,
  IngestionDlqEventSchema,
  type IngestionRequestedEvent,
  IngestionRequestedEventSchema,
  KAFKA_CONSUMER_GROUP,
  KAFKA_TOPICS,
} from "@rag/shared-types";
import { type Admin, type Consumer, Kafka, logLevel, type Producer } from "kafkajs";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  onDlq?: (dlqEvent: IngestionDlqEvent) => void | Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes a handler with exponential backoff and forwards failed payloads to DLQ after maxRetries.
 */
export async function executeWithRetryAndDlq(
  rawPayload: string,
  handler: (event: IngestionRequestedEvent) => Promise<void>,
  publishDlq: (dlqEvent: IngestionDlqEvent) => Promise<void>,
  options: RetryOptions = {},
): Promise<{ ok: boolean; attempts: number }> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleepFn ?? defaultSleep;

  const parsedJson = JSON.parse(rawPayload) as unknown;
  const event = IngestionRequestedEventSchema.parse(parsedJson);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await handler(event);
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * 2 ** (attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  const dlqPayload = IngestionDlqEventSchema.parse({
    originalEvent: event,
    errorMessage: lastError instanceof Error ? lastError.message : String(lastError),
    attempts: maxRetries,
    failedAt: new Date().toISOString(),
  });

  await publishDlq(dlqPayload);
  if (options.onDlq) {
    await options.onDlq(dlqPayload);
  }

  return { ok: false, attempts: maxRetries };
}

export class KafkaEventsService {
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;

  constructor(brokers: string[], clientId = "hybrid-rag-engine") {
    this.kafka = new Kafka({
      clientId,
      brokers,
      logLevel: logLevel.WARN,
    });
  }

  static fromBrokersString(brokersString: string, clientId?: string): KafkaEventsService {
    const brokers = brokersString
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    return new KafkaEventsService(brokers, clientId);
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer();
      await this.producer.connect();
    }
    return this.producer;
  }

  private async getAdmin(): Promise<Admin> {
    if (!this.admin) {
      this.admin = this.kafka.admin();
      await this.admin.connect();
    }
    return this.admin;
  }

  async ensureTopics(): Promise<void> {
    const admin = await this.getAdmin();
    const existing = await admin.listTopics();

    const toCreate: Array<{ topic: string; numPartitions: number; replicationFactor: number }> = [];
    if (!existing.includes(KAFKA_TOPICS.INGESTION_REQUESTED)) {
      toCreate.push({
        topic: KAFKA_TOPICS.INGESTION_REQUESTED,
        numPartitions: 3,
        replicationFactor: 1,
      });
    }
    if (!existing.includes(KAFKA_TOPICS.INGESTION_DLQ)) {
      toCreate.push({
        topic: KAFKA_TOPICS.INGESTION_DLQ,
        numPartitions: 1,
        replicationFactor: 1,
      });
    }

    if (toCreate.length > 0) {
      await admin.createTopics({
        waitForLeaders: true,
        topics: toCreate,
      });
    }
  }

  async publishIngestionRequested(event: IngestionRequestedEvent): Promise<void> {
    const validated = IngestionRequestedEventSchema.parse(event);
    const producer = await this.getProducer();
    await producer.send({
      topic: KAFKA_TOPICS.INGESTION_REQUESTED,
      messages: [
        {
          key: validated.repositoryId,
          value: JSON.stringify(validated),
        },
      ],
    });
  }

  async publishDlq(dlqEvent: IngestionDlqEvent): Promise<void> {
    const validated = IngestionDlqEventSchema.parse(dlqEvent);
    const producer = await this.getProducer();
    await producer.send({
      topic: KAFKA_TOPICS.INGESTION_DLQ,
      messages: [
        {
          key: validated.originalEvent.repositoryId,
          value: JSON.stringify(validated),
        },
      ],
    });
  }

  async startIngestionConsumer(
    handler: (event: IngestionRequestedEvent) => Promise<void>,
    options: RetryOptions & { groupId?: string } = {},
  ): Promise<void> {
    const groupId = options.groupId ?? KAFKA_CONSUMER_GROUP;
    this.consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 300_000,
      heartbeatInterval: 10_000,
    });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: KAFKA_TOPICS.INGESTION_REQUESTED,
      fromBeginning: true,
    });

    await this.consumer.run({
      eachMessage: async ({ message, heartbeat }) => {
        if (!message.value) {
          return;
        }
        const heartbeatTimer = setInterval(() => {
          void heartbeat().catch(() => {});
        }, 5_000);
        try {
          await executeWithRetryAndDlq(
            message.value.toString("utf-8"),
            handler,
            (dlq) => this.publishDlq(dlq),
            options,
          );
          await heartbeat();
        } finally {
          clearInterval(heartbeatTimer);
        }
      },
    });
  }

  async ping(): Promise<boolean> {
    const admin = await this.getAdmin();
    await admin.listTopics();
    return true;
  }

  async disconnect(): Promise<void> {
    await Promise.all([
      this.consumer?.disconnect(),
      this.producer?.disconnect(),
      this.admin?.disconnect(),
    ]);
    this.consumer = null;
    this.producer = null;
    this.admin = null;
  }
}
