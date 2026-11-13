import type {
  CreateRepositoryAcceptedResponse,
  CreateRepositoryRequest,
  RepositoryResponse,
  SearchHit,
  SearchRequest,
  SearchResult,
} from "@rag/shared-types";

export interface ReadyzResponse {
  status: "ready" | "degraded";
  dependencies: Record<string, boolean>;
}

export interface SymbolSearchResponse {
  symbolName: string;
  total: number;
  definitions: SearchHit[];
}

export interface DeleteRepositoryResponse {
  deleted: boolean;
  id: string;
  deletedChunks: number;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }

  return (await response.json()) as T;
}

export const ragApiClient = {
  async getReadyz(): Promise<ReadyzResponse> {
    const res = await fetch(`${API_BASE}/readyz`);
    return (await res.json()) as ReadyzResponse;
  },

  async listRepositories(): Promise<RepositoryResponse[]> {
    const data = await requestJson<{ repositories: RepositoryResponse[] }>("/api/v1/repositories");
    return data.repositories;
  },

  async createRepository(
    payload: CreateRepositoryRequest,
  ): Promise<CreateRepositoryAcceptedResponse> {
    return requestJson<CreateRepositoryAcceptedResponse>("/api/v1/repositories", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async deleteRepository(id: string): Promise<DeleteRepositoryResponse> {
    return requestJson<DeleteRepositoryResponse>(`/api/v1/repositories/${id}`, {
      method: "DELETE",
    });
  },

  async hybridSearch(payload: SearchRequest): Promise<SearchResult> {
    return requestJson<SearchResult>("/api/v1/search", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async getSymbolDefinition(
    symbolName: string,
    repositoryName?: string,
  ): Promise<SymbolSearchResponse> {
    const params = new URLSearchParams({ symbolName });
    if (repositoryName) {
      params.set("repositoryName", repositoryName);
    }
    return requestJson<SymbolSearchResponse>(`/api/v1/symbols?${params.toString()}`);
  },
};
