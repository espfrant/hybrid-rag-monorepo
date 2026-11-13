// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ragApiClient } from "../api/client";

vi.mock("../api/client", () => ({
  ragApiClient: {
    getReadyz: vi.fn(),
    listRepositories: vi.fn(),
    createRepository: vi.fn(),
    deleteRepository: vi.fn(),
    hybridSearch: vi.fn(),
    getSymbolDefinition: vi.fn(),
  },
}));

describe("@rag/web Console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ragApiClient.getReadyz).mockResolvedValue({
      status: "ready",
      dependencies: {
        postgres: true,
        redis: true,
        elasticsearch: true,
        kafka: true,
      },
    });
    vi.mocked(ragApiClient.listRepositories).mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "acme-core-service",
        url: "https://github.com/acme/core-service.git",
        defaultBranch: "main",
        status: "READY",
        lastIndexedCommit: "e18b0c29",
        createdAt: "2026-11-13T18:00:00.000Z",
        updatedAt: "2026-11-13T18:01:00.000Z",
        latestJob: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          repositoryId: "550e8400-e29b-41d4-a716-446655440001",
          commitHash: "e18b0c29",
          status: "COMPLETED",
          totalChunks: 350,
          errorMessage: null,
          startedAt: "2026-11-13T18:00:05.000Z",
          completedAt: "2026-11-13T18:01:00.000Z",
        },
      },
    ]);
    vi.mocked(ragApiClient.hybridSearch).mockResolvedValue({
      query: "rrf",
      cached: true,
      total: 1,
      results: [
        {
          chunkId: "c1",
          repositoryId: "550e8400-e29b-41d4-a716-446655440001",
          repositoryName: "acme-core-service",
          filePath: "README.md",
          language: "markdown",
          symbolName: "Reciprocal Rank Fusion",
          symbolType: "markdown_section",
          content: "## Reciprocal Rank Fusion",
          startLine: 69,
          endLine: 92,
          commitHash: "e18b0c29",
          score: 0.0328,
        },
      ],
    });
  });

  it("renders infrastructure health, performs hybrid search, and switches to repositories registry", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("PostgreSQL 17")).toBeTruthy();
      expect(screen.getByText("Proyectos Indexados (1)")).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText(/reciprocal rank fusion/i);
    fireEvent.change(searchInput, { target: { value: "rrf" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => {
      expect(screen.getByText("Redis Cache Hit")).toBeTruthy();
      expect(screen.getByText("Reciprocal Rank Fusion")).toBeTruthy();
      expect(screen.getByText("L69-L92")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Proyectos Indexados/i }));

    await waitFor(() => {
      expect(screen.getByText("350")).toBeTruthy();
      expect(screen.getByText("READY")).toBeTruthy();
    });
  });
});
