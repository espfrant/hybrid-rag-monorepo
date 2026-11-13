import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type ReadyzResponse, ragApiClient } from "../api/client";

const SERVICE_LABELS: Array<{ key: string; label: string }> = [
  { key: "postgres", label: "PostgreSQL 17" },
  { key: "redis", label: "Redis 7" },
  { key: "elasticsearch", label: "Elasticsearch 8.15" },
  { key: "kafka", label: "Kafka KRaft" },
];

export function StackHealthBar() {
  const [health, setHealth] = useState<ReadyzResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ragApiClient.getReadyz();
      setHealth(res);
      setOffline(false);
    } catch {
      setOffline(true);
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const timer = setInterval(() => {
      void checkHealth();
    }, 15_000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold tracking-wide text-slate-400 uppercase">
          Infraestructura
        </span>
        {offline ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-1 font-medium text-rose-300">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            API desconectada (localhost:3000)
          </span>
        ) : (
          SERVICE_LABELS.map(({ key, label }) => {
            const ok = health?.dependencies[key] ?? false;
            return (
              <span
                key={key}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
                  ok ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400"}`}
                />
                {label}
              </span>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={() => void checkHealth()}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-slate-300 transition hover:bg-slate-700 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        Comprobar
      </button>
    </div>
  );
}
