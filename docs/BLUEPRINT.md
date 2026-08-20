# Production Blueprint: LLM Code Review Platform

This document is the implementation source of truth for building and scaling the platform.

## 1) Product scope

- Real-time IDE code reviews with inline diagnostics and suggested fixes.
- Automated GitHub PR reviews (summary + inline comments on changed lines).
- Hybrid analysis: deterministic static checks + LLM reasoning.
- Memory-augmented reviews using Pinecone for historical context.
- Metrics and evaluation dashboard for quality/performance tracking.

## 2) Monorepo structure

```text
code-review-platform/
  apps/
    api/                   # FastAPI gateway + auth + orchestration
    worker/                # Async queue consumers for PR/eval jobs
    dashboard/             # React UI for metrics/eval visibility
  packages/
    extension/             # VS Code extension (manual + save-trigger review)
    python-common/         # Shared pipeline, DB models, RAG, GitHub adapters
    prompts/               # Versioned prompt templates
    contracts/             # OpenAPI contract
    sdk-ts/                # TypeScript client
  infra/
    compose/               # Dockerfiles + Compose + optional TLS
    migrations/            # Alembic migrations
  eval/
    golden.jsonl           # Offline evaluation set
  docs/
    ARCHITECTURE.md
    DEPLOYMENT.md
    GITHUB_APP.md
    RUNBOOK.md
    SECURITY.md
    EXTENSION.md
    BLUEPRINT.md
```

## 3) Service architecture

- `packages/extension` -> calls `apps/api` with bearer auth.
- `apps/api` -> runs synchronous realtime pipeline and persists findings.
- `apps/api` -> enqueues PR/eval jobs to Redis.
- `apps/worker` -> dequeues jobs, calls GitHub APIs, runs pipeline, posts PR comments/check runs.
- `packages/python-common/review/pipeline.py` -> static checks + LLM call + dedupe.
- `packages/python-common/rag/pinecone_service.py` -> semantic memory retrieval and upsert.
- `apps/dashboard` -> reads `/v1/metrics/summary` and `/v1/eval/runs`.

## 4) API contract (production)

Current endpoints are defined in `packages/contracts/openapi.yaml`.

- `GET /health`, `GET /ready`
- `POST /v1/reviews/realtime`
- `POST /v1/reviews/realtime/stream`
- `POST /v1/reviews/pr`
- `GET /v1/reviews/{review_id}`
- `POST /v1/webhooks/github`
- `POST /v1/memory/search`
- `POST /v1/memory/upsert`
- `GET /v1/metrics/summary`
- `POST /v1/eval/run`
- `GET /v1/eval/runs`

## 5) Prompting strategy

Prompt files:

- `packages/prompts/system.reviewer.v1.txt`
- `packages/prompts/user.realtime.v1.j2`
- `packages/prompts/user.pr_chunk.v1.j2`

Guidelines:

- Keep prompts versioned (`*.vN.*`) and immutable.
- Embed strict JSON schema constraints in system prompts.
- Treat source code content as untrusted prompt input.
- Record prompt versions in `reviews.prompt_versions` for auditability.

## 6) Data model summary

Primary entities in `packages/python-common/src/codereview_common/db/models.py`:

- `organizations`, `repos`, `api_keys`
- `reviews` (source, status, model, latency, token usage)
- `findings` (severity/category/path/line/fingerprint/payload_json/github_comment_id)
- `review_chunks` (future advanced chunk-level tracking)
- `eval_runs` (dataset/model/metrics)
- `github_installations`, `idempotency_keys`

Production index recommendations:

- `reviews(org_id, created_at DESC)`
- `findings(review_id, severity, category)`
- `idempotency_keys(delivery_id)` PK already present

## 7) LLM provider abstraction

Supported providers:

- OpenAI (`OPENAI_API_KEY`)
- Mistral (`MISTRAL_API_KEY`)
- Ollama-compatible APIs (`OLLAMA_BASE_URL`)

Runtime selection:

- Global defaults via env.
- Per-request override via `provider` and `model`.

## 8) PR automation behavior

Worker flow:

1. Validate and dequeue `pr_review` job.
2. Fetch PR files from GitHub.
3. Run per-file patch reviews (not only merged diff blob).
4. Persist findings in Postgres.
5. Publish:
   - Check run summary.
   - Pull request review body.
   - Inline comments mapped to changed lines when possible.

Safety:

- Webhook idempotency using `X-GitHub-Delivery`.
- Signature validation via `X-Hub-Signature-256`.
- Installation mapping via `github_installations` or `WEBHOOK_DEFAULT_ORG_ID`.

## 9) Quality and security analysis layers

Current layered approach:

- Static deterministic checks (`static.v1`) for high-signal patterns.
- LLM deep semantic analysis for bug/security/quality/perf/maintainability.
- Dedupe via deterministic fingerprinting.

Recommended future additions:

- Optional Semgrep/Bandit pass with language-aware rulesets.
- SAST severity normalization policy.
- Triage state machine (`open`, `accepted_risk`, `fixed`, `false_positive`).

## 10) Evaluation and observability

Online metrics:

- Reviews in last 7 days.
- P95 review latency.
- Average findings per review.
- Findings by category.

Offline eval:

- Golden set replay (`/v1/eval/run`).
- Historical eval runs (`/v1/eval/runs`).
- Track recall/precision drift by model/prompt/provider.

Recommended SLOs:

- P95 realtime review latency < 8s (excluding cold model startup).
- PR review completion < 3 minutes for <= 8 changed files.
- Webhook-to-queue enqueue success > 99.9%.

## 11) Deployment model

Minimum production deployment:

- API service (stateless replicas)
- Worker service (horizontal replicas)
- Postgres (managed preferred)
- Redis (managed preferred)
- Pinecone index
- Reverse proxy / ingress with TLS

Secrets:

- Inject via secret manager (not `.env` in production).
- Rotate API keys and GitHub App credentials periodically.

## 12) Implementation phases

### Phase A: Foundation (week 1-2)
- Boot monorepo, contracts, DB migrations.
- API auth, health/ready, core realtime endpoint.
- Extension MVP for manual file review.

### Phase B: Provider + Memory (week 2-3)
- OpenAI/Mistral/Ollama adapter hardening.
- Pinecone search/upsert + namespace isolation.
- Prompt versioning and persistence metadata.

### Phase C: PR automation (week 3-4)
- GitHub webhook validation + idempotency.
- Worker PR ingestion and check runs.
- Inline PR comments mapped to changed lines.

### Phase D: Quality controls (week 4-5)
- Static checks + LLM hybrid pass.
- Severity calibration and false positive controls.
- Security-focused regression datasets.

### Phase E: Metrics + eval (week 5-6)
- Dashboard cards/charts.
- Offline replay pipeline with model comparison.
- KPI/SLO alerting and release gates.

### Phase F: Hardening (week 6+)
- Load/stress testing and autoscaling policy.
- Multi-tenant governance and RBAC scopes.
- Incident runbooks and disaster recovery drills.

## 13) Test strategy roadmap

Unit:

- Prompt rendering, parser resilience, static checks, dedupe logic, webhook signature validation.

Integration:

- FastAPI endpoints with auth + DB.
- Redis queue + worker job handling.
- GitHub API stubs for PR comment/check behavior.

E2E:

- Extension -> API realtime review.
- GitHub webhook -> worker -> review + comments.
- Eval run queue -> dashboard visibility.

Non-functional:

- k6 latency and throughput sweeps.
- Failure-injection (LLM timeout, Redis down, DB failover).
- Security testing (authz boundaries, secret redaction, injection attempts).
