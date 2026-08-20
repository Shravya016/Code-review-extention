# Runbook

## API unhealthy

1. `curl -s localhost:8000/health` should return `ok`.
2. `curl -s localhost:8000/ready` checks Postgres (`SELECT 1`) and Redis `PING`.
3. Inspect `docker compose logs api` for stack traces.

## Worker idle / queue growing

1. `redis-cli LLEN codereview:jobs` — list length for pending jobs (BRPOP queue).
2. Scale `worker` replicas in Compose.
3. Check LLM rate limits (429) in worker logs; add backoff or reduce concurrency.

## GitHub comments failing

1. Verify installation token exchange (`GITHUB_APP_ID`, PEM formatting with literal `\n` in env if needed).
2. Confirm app permissions: Contents read, Pull requests read/write, Checks write.
3. Large PRs: worker truncates files; adjust limits in `codereview_worker.main`.

## Database migration failures

1. Ensure `DATABASE_URL` sync form works (Alembic env strips `+asyncpg`).
2. Run `alembic current` and `alembic history` to detect drift.

## Pinecone errors

1. Index dimension must match embedding model (default OpenAI `text-embedding-3-small` = 1536).
2. Confirm namespace filters include org/repo for all queries.
