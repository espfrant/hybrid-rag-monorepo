import type { IngestionDlqEvent } from "@rag/shared-types";
import { describe, expect, it, vi } from "vitest";
import { executeWithRetryAndDlq } from "../index.js";

const validEvent = JSON.stringify({
  jobId: "550e8400-e29b-41d4-a716-446655440000",
  repositoryId: "550e8400-e29b-41d4-a716-446655440001",
  repositoryUrl: "https://github.com/org/repo.git",
  branch: "main",
  requestedAt: "2026-11-13T12:00:00Z",
});

describe("@rag/events retry & DLQ handler", () => {
  it("succeeds on transient failure using exponential backoff without sending to DLQ", async () => {
    const sleepDelays: number[] = [];
    const publishDlq = vi.fn<(_: IngestionDlqEvent) => Promise<void>>().mockResolvedValue();
    let calls = 0;

    const result = await executeWithRetryAndDlq(
      validEvent,
      async () => {
        calls++;
        if (calls < 2) {
          throw new Error("temporary network glitch");
        }
      },
      publishDlq,
      {
        maxRetries: 3,
        baseDelayMs: 100,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    );

    expect(result).toEqual({ ok: true, attempts: 2 });
    expect(sleepDelays).toEqual([100]);
    expect(publishDlq).not.toHaveBeenCalled();
  });

  it("publishes to docs.ingestion.dlq after 3 consecutive failures", async () => {
    const sleepDelays: number[] = [];
    const publishDlq = vi.fn<(_: IngestionDlqEvent) => Promise<void>>().mockResolvedValue();

    const result = await executeWithRetryAndDlq(
      validEvent,
      async () => {
        throw new Error("fatal parse failure");
      },
      publishDlq,
      {
        maxRetries: 3,
        baseDelayMs: 50,
        sleepFn: async (ms) => {
          sleepDelays.push(ms);
        },
      },
    );

    expect(result).toEqual({ ok: false, attempts: 3 });
    expect(sleepDelays).toEqual([50, 100]);
    expect(publishDlq).toHaveBeenCalledTimes(1);
    const dlqArg = publishDlq.mock.calls[0]?.[0];
    expect(dlqArg?.attempts).toBe(3);
    expect(dlqArg?.errorMessage).toBe("fatal parse failure");
    expect(dlqArg?.originalEvent.jobId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
