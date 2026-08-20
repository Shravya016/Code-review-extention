// k6 smoke: API_KEY and BASE_URL env vars (see docs/DEPLOYMENT.md)
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 2,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<5000"],
  },
};

const BASE = __ENV.BASE_URL || "http://localhost:8000";
const TOKEN = __ENV.API_KEY || "";

export default function () {
  const params = TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {};
  const h = http.get(`${BASE}/health`);
  check(h, { "health 200": (r) => r.status === 200 });
  if (TOKEN) {
    const body = JSON.stringify({
      language: "python",
      path: "smoke.py",
      content: "def add(a,b): return a+b\n",
      enable_memory: false,
    });
    const r = http.post(`${BASE}/v1/reviews/realtime`, body, {
      ...params,
      headers: { ...params.headers, "Content-Type": "application/json" },
    });
    check(r, { "realtime 200": (x) => x.status === 200 });
  }
  sleep(1);
}
