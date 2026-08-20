# Security

## Threat model (summary)

| Threat | Mitigation |
|--------|------------|
| Stolen API keys | Store hashed keys in `api_keys` for production; rotate keys; scope per org. |
| Webhook spoofing | Require `GITHUB_WEBHOOK_SECRET`; verify `sha256` HMAC; idempotency on `X-GitHub-Delivery`. |
| Secret leakage to LLM/embeddings | `redact_for_embedding` strips PEM blocks and obvious `api_key=` patterns. |
| Prompt injection via repo code | System prompt instructs model to treat code as data; multi-tenant isolation via org/repo filters. |
| SSRF from worker | Worker only calls `api.github.com` with installation tokens; no arbitrary URLs from users. |

## Data handling

- **Postgres** holds structured `findings` JSON and review metadata.
- **Pinecone** stores embeddings of redacted summaries; do not place raw credentials in metadata.
- Configure retention policies for `review_chunks` if you enable raw storage in future revisions.

## Transport

Terminate TLS at Caddy/Traefik or cloud LB. Do not expose Postgres or Redis publicly.
