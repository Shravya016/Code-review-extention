# Deployment (Docker Compose on VMs)

## Prerequisites

- VM with Docker Engine + Compose plugin
- DNS pointing to the VM if using GitHub webhooks and TLS
- Secrets: OpenAI (and/or Mistral) API keys, Pinecone API key + index name, GitHub App ID + PEM private key, webhook secret

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | `postgresql+asyncpg://user:pass@postgres:5432/db` |
| `REDIS_URL` | `redis://redis:6379/0` |
| `API_KEYS` | Comma-separated `plaintextKey:org-uuid` pairs for extension/dashboard |
| `WEBHOOK_DEFAULT_ORG_ID` | Fallback org UUID when installation is not yet mapped |
| `DEFAULT_LLM_PROVIDER` | `openai`, `mistral`, or `ollama` (default `openai`) |
| `DEFAULT_LLM_MODEL` | Model id, e.g. `deepseek-coder:6.7b` for Ollama |
| `OLLAMA_BASE_URL` | OpenAI-compatible base URL including `/v1`, e.g. `http://127.0.0.1:11434/v1` |
| `OPENAI_API_KEY` / `MISTRAL_API_KEY` | LLM credentials (not required if using Ollama only) |
| `PINECONE_API_KEY` / `PINECONE_INDEX` | Vector memory (optional) |
| `EMBEDDING_PROVIDER` | `ollama` or `openai` (defaults to Ollama if `OLLAMA_BASE_URL` is set and no OpenAI key) |
| `EMBEDDING_MODEL` | Ollama: `nomic-embed-text` (768 dim). OpenAI: `text-embedding-3-small` (1536 dim) |
| `EMBEDDING_DIMENSION` | Must match Pinecone index (768 for `nomic-embed-text`) |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | PEM text for JWT exchange |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for `X-Hub-Signature-256` |

## Migrations

From the repository root (with Postgres reachable):

```bash
export DATABASE_URL=postgresql+asyncpg://codereview:codereview@localhost:5432/codereview
uv sync --all-packages
uv run alembic -c infra/migrations/alembic.ini upgrade head
```

Alembic strips `+asyncpg` automatically in `env.py`.

## Compose

```bash
cd infra/compose
docker compose up --build -d
```

Optional TLS profile:

```bash
docker compose --profile tls up -d
```

## Backups

Schedule `pg_dump` for the `codereview` database and snapshot Redis only if you rely on queued-but-not-processed jobs (usually ephemeral).

## Load / smoke testing

From repo root, with the API running: `k6 run load/k6/smoke.js` (set `BASE_URL` and optional `API_KEY`). For Locust or heavier scenarios, add a `locustfile.py` that hits `/v1/reviews/realtime/stream` with bearer auth and monitor LLM rate limits.

## Scaling

Run additional `worker` service replicas with the same `REDIS_URL` and `DATABASE_URL`. Keep the API stateless behind your reverse proxy.
