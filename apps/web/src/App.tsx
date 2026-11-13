import type { RepositoryResponse } from "@rag/shared-types";
import { Cpu, FolderGit2, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ragApiClient } from "./api/client";
import { RepositoriesPanel } from "./components/RepositoriesPanel";
import { SearchPlayground } from "./components/SearchPlayground";
import { StackHealthBar } from "./components/StackHealthBar";

type ActiveTab = "search" | "repositories";

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("search");
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);

  const loadRepositories = useCallback(async () => {
    try {
      const list = await ragApiClient.listRepositories();
      setRepositories(list);
    } catch {
      // StackHealthBar already indicates when API is offline
    }
  }, []);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600/20 text-indigo-400 ring-1 ring-indigo-500/30">
                <Cpu className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Hybrid RAG &amp; MCP Console
                </h1>
                <p className="text-xs text-slate-400">
                  AST Chunking · ONNX 768d Local · Elasticsearch RRF · Redis Cache
                </p>
              </div>
            </div>
          </div>

          <nav className="inline-flex rounded-xl border border-slate-800 bg-slate-900 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("search")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition ${
                activeTab === "search"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Search className="h-3.5 w-3.5" />
              Buscador RAG
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("repositories")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition ${
                activeTab === "repositories"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <FolderGit2 className="h-3.5 w-3.5" />
              Proyectos Indexados ({repositories.length})
            </button>
          </nav>
        </header>

        <StackHealthBar />

        <main>
          {activeTab === "search" ? (
            <SearchPlayground repositories={repositories} />
          ) : (
            <RepositoriesPanel
              repositories={repositories}
              onRepositoriesChange={loadRepositories}
            />
          )}
        </main>
      </div>
    </div>
  );
}
