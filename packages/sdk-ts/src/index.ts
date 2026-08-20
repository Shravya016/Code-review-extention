/**
 * Hand-maintained client types aligned with packages/contracts/openapi.yaml
 */

export type Finding = {
  id: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  detail: string;
  cwe_id?: string | null;
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  suggested_fix?: string | null;
  references?: string[];
};

export type ReviewResult = {
  review_id: string;
  model: string;
  prompt_versions: string[];
  findings: Finding[];
  token_usage?: Record<string, unknown> | null;
  latency_ms?: number | null;
};

export type RealtimeReviewRequest = {
  org_id?: string;
  repo_id?: string;
  language?: string;
  path?: string | null;
  content: string;
  diff?: string | null;
  model?: string | null;
  provider?: string | null;
  enable_memory?: boolean;
};

export type MetricsSummary = {
  reviews_last_7d: number;
  p95_latency_ms: number | null;
  avg_findings_per_review: number | null;
  by_category: Record<string, number>;
};

export type EvalRunRecord = {
  id: string;
  dataset: string;
  model: string;
  metrics: Record<string, unknown>;
  created_at: string;
};

export type EvalRunsResponse = {
  runs: EvalRunRecord[];
};

export async function postRealtimeReview(
  baseUrl: string,
  token: string,
  body: RealtimeReviewRequest
): Promise<ReviewResult> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/reviews/realtime`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CodeReview API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<ReviewResult>;
}

export async function getMetricsSummary(baseUrl: string, token: string): Promise<MetricsSummary> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/metrics/summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`CodeReview API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<MetricsSummary>;
}

export async function listEvalRuns(
  baseUrl: string,
  token: string,
  limit = 20
): Promise<EvalRunsResponse> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/v1/eval/runs`);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`CodeReview API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<EvalRunsResponse>;
}
