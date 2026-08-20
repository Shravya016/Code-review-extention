import { useEffect, useState } from "react";

type Metrics = {
  reviews_last_7d: number;
  p95_latency_ms: number | null;
  avg_findings_per_review: number | null;
  by_category: Record<string, number>;
};

type EvalRun = {
  id: string;
  dataset: string;
  model: string;
  metrics: Record<string, unknown>;
  created_at: string;
};

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem("codereview_token") || "");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [evalRuns, setEvalRuns] = useState<EvalRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("codereview_token", token);
  }, [token]);

  const load = async () => {
    setError(null);
    try {
      const res = await fetch("/v1/metrics/summary", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      setMetrics(await res.json());
      const evalRes = await fetch("/v1/eval/runs?limit=10", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (evalRes.ok) {
        const payload = (await evalRes.json()) as { runs?: EvalRun[] };
        setEvalRuns(payload.runs || []);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 720 }}>
      <h1>CodeReview metrics</h1>
      <p>Paste an API key (Bearer token) configured via API_KEYS on the server.</p>
      <input
        style={{ width: "100%", padding: 8, marginBottom: 8 }}
        placeholder="API key"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <button type="button" onClick={load}>
        Refresh
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {metrics && (
        <div style={{ marginTop: 24 }}>
          <h2>Last 7 days</h2>
          <ul>
            <li>Reviews: {metrics.reviews_last_7d}</li>
            <li>P95 latency (ms): {metrics.p95_latency_ms ?? "n/a"}</li>
            <li>Avg findings / review: {metrics.avg_findings_per_review ?? "n/a"}</li>
          </ul>
          <h3>By category</h3>
          <pre>{JSON.stringify(metrics.by_category, null, 2)}</pre>
          <button type="button" onClick={() => navigator.clipboard.writeText(JSON.stringify(metrics))}>
            Export JSON
          </button>
          <h3>Recent eval runs</h3>
          <ul>
            {evalRuns.length === 0 && <li>No eval runs yet.</li>}
            {evalRuns.map((run) => (
              <li key={run.id}>
                {new Date(run.created_at).toLocaleString()} | {run.dataset} | {run.model} |{" "}
                {JSON.stringify(run.metrics)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
