import type { RepositoryResponse, SearchHit, SearchResult } from "@rag/shared-types";
import { Check, Code2, Copy, Database, Search, Sparkles, Zap } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ragApiClient } from "../api/client";

interface SearchPlaygroundProps {
  repositories: RepositoryResponse[];
}

type SearchMode = "hybrid" | "symbol";

export function SearchPlayground({ repositories }: SearchPlaygroundProps) {
  const [mode, setMode] = useState<SearchMode>("hybrid");
  const [query, setQuery] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [language, setLanguage] = useState("");
  const [topK, setTopK] = useState(8);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hybridResult, setHybridResult] = useState<SearchResult | null>(null);
  const [symbolHits, setSymbolHits] = useState<SearchHit[] | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const readyRepos = repositories.filter((r) => r.status === "READY");

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (mode === "hybrid") {
        const res = await ragApiClient.hybridSearch({
          query: query.trim(),
          repositoryName: repositoryName || undefined,
          language: language || undefined,
          topK,
        });
        setHybridResult(res);
        setSymbolHits(null);
      } else {
        const res = await ragApiClient.getSymbolDefinition(
          query.trim(),
          repositoryName || undefined,
        );
        setSymbolHits(res.definitions);
        setHybridResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al ejecutar la búsqueda");
    } finally {
      setLoading(false);
    }
  };

  const copyContent = async (hit: SearchHit) => {
    await navigator.clipboard.writeText(hit.content);
    setCopiedId(hit.chunkId);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const displayedHits = mode === "hybrid" ? (hybridResult?.results ?? []) : (symbolHits ?? []);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-xl border border-slate-800 bg-slate-950 p-1">
            <button
              type="button"
              onClick={() => setMode("hybrid")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "hybrid"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Búsqueda Híbrida (BM25 + kNN RRF)
            </button>
            <button
              type="button"
              onClick={() => setMode("symbol")}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                mode === "symbol"
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              Definición Exacta de Símbolo
            </button>
          </div>

          {mode === "hybrid" && hybridResult && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                hybridResult.cached
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
                  : "border-sky-500/30 bg-sky-500/15 text-sky-300"
              }`}
            >
              {hybridResult.cached ? (
                <>
                  <Zap className="h-3.5 w-3.5" />
                  Redis Cache Hit
                </>
              ) : (
                <>
                  <Database className="h-3.5 w-3.5" />
                  Elasticsearch (Cache Miss)
                </>
              )}
            </span>
          )}
        </div>

        <form onSubmit={(e) => void handleSearch(e)} className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-500" />
              <input
                type="text"
                required
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  mode === "hybrid"
                    ? "Ej: reciprocal rank fusion hybrid search cache invalidation"
                    : "Ej: fuseWithRrf o HybridSearchOrchestrator"
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pr-3 pl-9 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {loading ? "Buscando..." : "Buscar"}
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="filter-repo" className="mb-1 block text-xs text-slate-400">
                Repositorio
              </label>
              <select
                id="filter-repo"
                value={repositoryName}
                onChange={(e) => setRepositoryName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Todos los repositorios ({readyRepos.length})</option>
                {readyRepos.map((repo) => (
                  <option key={repo.id} value={repo.name}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </div>

            {mode === "hybrid" && (
              <>
                <div>
                  <label htmlFor="filter-lang" className="mb-1 block text-xs text-slate-400">
                    Lenguaje
                  </label>
                  <select
                    id="filter-lang"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">Todos</option>
                    <option value="typescript">TypeScript</option>
                    <option value="javascript">JavaScript</option>
                    <option value="python">Python</option>
                    <option value="go">Go</option>
                    <option value="markdown">Markdown</option>
                    <option value="pdf">PDF</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="filter-topk" className="mb-1 block text-xs text-slate-400">
                    Top K resultados
                  </label>
                  <input
                    id="filter-topk"
                    type="number"
                    min={1}
                    max={50}
                    value={topK}
                    onChange={(e) => setTopK(Number(e.target.value) || 8)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </>
            )}
          </div>
        </form>

        {error && (
          <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </p>
        )}
      </div>

      {(hybridResult !== null || symbolHits !== null) && (
        <div className="space-y-3">
          <div className="text-xs font-medium text-slate-400">
            {displayedHits.length} fragmentos encontrados
          </div>

          {displayedHits.length === 0 ? (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-400">
              No se encontraron fragmentos para esta consulta.
            </div>
          ) : (
            displayedHits.map((hit) => (
              <article
                key={hit.chunkId}
                className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60"
              >
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/60 px-4 py-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-indigo-500/20 px-2 py-0.5 font-medium text-indigo-300">
                      {hit.repositoryName}
                    </span>
                    <span className="font-mono text-slate-200">{hit.filePath}</span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-slate-400">
                      L{hit.startLine}-L{hit.endLine}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="rounded border border-slate-700 px-2 py-0.5 text-slate-300">
                      {hit.symbolType}: <strong>{hit.symbolName}</strong>
                    </span>
                    <span className="font-mono text-slate-400">score {hit.score.toFixed(4)}</span>
                    <button
                      type="button"
                      onClick={() => void copyContent(hit)}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-slate-300 hover:bg-slate-700"
                    >
                      {copiedId === hit.chunkId ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copiedId === hit.chunkId ? "Copiado" : "Copiar"}
                    </button>
                  </div>
                </header>

                <pre className="max-h-80 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-slate-200">
                  <code>{hit.content}</code>
                </pre>
              </article>
            ))
          )}
        </div>
      )}
    </div>
  );
}
