import type { RepositoryResponse, RepositoryStatus } from "@rag/shared-types";
import { FolderGit2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ragApiClient } from "../api/client";

interface RepositoriesPanelProps {
  repositories: RepositoryResponse[];
  onRepositoriesChange: () => Promise<void>;
}

const STATUS_BADGE: Record<RepositoryStatus, string> = {
  PENDING: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  INDEXING: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  READY: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  FAILED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function RepositoriesPanel({ repositories, onRepositoriesChange }: RepositoriesPanelProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasActiveJobs = repositories.some(
    (repo) => repo.status === "PENDING" || repo.status === "INDEXING",
  );

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }
    const timer = setInterval(() => {
      void onRepositoriesChange();
    }, 2500);
    return () => clearInterval(timer);
  }, [hasActiveJobs, onRepositoriesChange]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!name.trim() || !url.trim()) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await ragApiClient.createRepository({
          name: name.trim(),
          url: url.trim(),
          defaultBranch: branch.trim() || "main",
        });
        setName("");
        setUrl("");
        setBranch("main");
        await onRepositoriesChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Error al registrar repositorio");
      } finally {
        setSubmitting(false);
      }
    },
    [name, url, branch, onRepositoriesChange],
  );

  const handleReindex = async (repo: RepositoryResponse) => {
    setBusyId(repo.id);
    setError(null);
    try {
      await ragApiClient.createRepository({
        name: repo.name,
        url: repo.url,
        defaultBranch: repo.defaultBranch,
      });
      await onRepositoriesChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al re-indexar");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (repo: RepositoryResponse) => {
    setBusyId(repo.id);
    setError(null);
    try {
      await ragApiClient.deleteRepository(repo.id);
      await onRepositoriesChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al eliminar repositorio");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
      >
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200">
          <FolderGit2 className="h-4 w-4 text-indigo-400" />
          Registrar Repositorio para Indexación
        </div>

        <div className="grid gap-3 md:grid-cols-12">
          <div className="md:col-span-3">
            <label htmlFor="repo-name" className="mb-1 block text-xs text-slate-400">
              Nombre del proyecto
            </label>
            <input
              id="repo-name"
              type="text"
              required
              placeholder="acme-core-service"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="md:col-span-5">
            <label htmlFor="repo-url" className="mb-1 block text-xs text-slate-400">
              URL Git o Ruta Local
            </label>
            <input
              id="repo-url"
              type="text"
              required
              placeholder="https://github.com/acme/core-service.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="repo-branch" className="mb-1 block text-xs text-slate-400">
              Rama
            </label>
            <input
              id="repo-branch"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="flex items-end md:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {submitting ? "Encolando..." : "Indexar"}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </p>
        )}
      </form>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-200">
            Proyectos Indexados ({repositories.length})
          </h2>
          <button
            type="button"
            onClick={() => void onRepositoriesChange()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${hasActiveJobs ? "animate-spin" : ""}`} />
            Actualizar
          </button>
        </div>

        {repositories.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No hay repositorios registrados todavía. Añade uno arriba para empezar a indexar.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-5 py-3">Proyecto</th>
                  <th className="px-5 py-3">Origen / Rama</th>
                  <th className="px-5 py-3">Estado</th>
                  <th className="px-5 py-3">Chunks</th>
                  <th className="px-5 py-3">Commit</th>
                  <th className="px-5 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {repositories.map((repo) => (
                  <tr key={repo.id} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3.5 font-medium text-slate-100">{repo.name}</td>
                    <td className="px-5 py-3.5 text-xs text-slate-400">
                      <div className="max-w-xs truncate" title={repo.url}>
                        {repo.url}
                      </div>
                      <span className="text-slate-500">rama: {repo.defaultBranch}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[repo.status]}`}
                      >
                        {repo.status}
                      </span>
                      {repo.latestJob?.errorMessage && (
                        <p className="mt-1 max-w-xs truncate text-xs text-rose-400">
                          {repo.latestJob.errorMessage}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-300">
                      {repo.latestJob?.totalChunks ?? 0}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-slate-400">
                      {repo.lastIndexedCommit ? repo.lastIndexedCommit.slice(0, 8) : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busyId === repo.id}
                          onClick={() => void handleReindex(repo)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Re-indexar
                        </button>
                        <button
                          type="button"
                          disabled={busyId === repo.id}
                          onClick={() => void handleDelete(repo)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
