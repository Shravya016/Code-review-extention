# LLM-Powered Automated Code Review Platform

Monorepo containing a FastAPI API, async workers, VS Code extension, metrics dashboard, Pinecone-backed RAG memory, and GitHub App integration for automated PR reviews.

## Repository layout

| Path | Description |
|------|-------------|
| `apps/api` | FastAPI service (REST, SSE, webhooks) |
| `apps/worker` | Redis-backed job consumer for PR reviews |
| `apps/dashboard` | Vite + React metrics and eval UI |
| `packages/python-common` | Shared domain logic, LLM adapters, DB models |
| `packages/contracts` | OpenAPI 3.1 specification |
| `packages/prompts` | Versioned prompt templates |
| `packages/extension` | VS Code / Cursor extension |
| `packages/sdk-ts` | TypeScript API client (hand-maintained from OpenAPI) |
| `infra/compose` | Docker Compose stacks |
| `infra/migrations` | Alembic migrations |
| `docs` | Architecture, deployment, security, runbooks |
| `eval` | Golden datasets and offline eval scripts |

## Quick start (local development)

### Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Node.js 20+ and pnpm
- Docker (for Postgres, Redis, optional Caddy)

### Python

```bash
uv sync --all-packages
uv run pytest
```

### Run API locally

Copy [.env.example](.env.example) to `.env` in the repo root (or export the same variables). For **Ollama only**, set `DEFAULT_LLM_PROVIDER=ollama`, `DEFAULT_LLM_MODEL=deepseek-coder:6.7b`, and `OLLAMA_BASE_URL` (must end with `/v1`). Pull the model first: `ollama pull deepseek-coder:6.7b`.

```bash
export DATABASE_URL=postgresql+asyncpg://codereview:codereview@localhost:5432/codereview
export REDIS_URL=redis://localhost:6379/0
export API_KEYS=devkey:00000000-0000-0000-0000-000000000001
uv run --project apps/api uvicorn codereview_api.main:app --reload --host 0.0.0.0 --port 8000
```

### Docker Compose (full stack)

Copy [infra/compose/.env.example](infra/compose/.env.example) to `infra/compose/.env` when you need Ollama on the host (`OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` on Windows/Mac).

```bash
cd infra/compose
docker compose up --build
```

API: `http://localhost:8000`.

### Extension

```bash
cd packages/extension
pnpm install
pnpm run compile
```

Press F5 in VS Code to launch the Extension Development Host.

## Load testing

- **k6**: `k6 run load/k6/smoke.js` (set `BASE_URL`, optional `API_KEY`).
- **Locust**: outline in repository comments; use a `locustfile` that targets `/v1/reviews/realtime/stream` with bearer auth and respect rate limits.

## Configuration

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for environment variables and secrets.

## Project objectives

[docs/OBJECTIVES.md](docs/OBJECTIVES.md) — main objective, eight primary objectives (aligned with the live system), optional extensions, scope boundaries, and success criteria.

## Module breakdown (for presentation)

[docs/MODULES.md](docs/MODULES.md) categorises every folder into 12 logical modules, with responsibilities, key files, mermaid diagrams of the full-system flow and the GitHub-PR flow, and a suggested presentation order for an academic/supervisor walkthrough.

## Results, analysis and conclusion

[docs/RESULTS_ANALYSIS_CONCLUSION.md](docs/RESULTS_ANALYSIS_CONCLUSION.md) — test outcomes, analysis of strengths and limitations, and final conclusion for the project report.

## Full implementation blueprint

See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for:

- production architecture and modular boundaries
- endpoint and schema map
- prompt versioning strategy
- DB model and indexing guidance
- phased implementation and testing roadmap

## Pre-push quality gate

Use the built-in pre-push hook to block pushes on high-severity findings. Setup and configuration:

- [docs/PRE_PUSH_GATE.md](docs/PRE_PUSH_GATE.md)

## Continuous integration

See [.github/workflows/ci.yml](.github/workflows/ci.yml).

## License

MIT
