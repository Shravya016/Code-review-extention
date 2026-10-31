# Render deployment

Deploy the repository's `render.yaml` as a Render Blueprint. This creates an API
with the dashboard at `/`, a background worker, private PostgreSQL, and private
Redis-compatible Key Value in Singapore. These are paid services: review Render's
estimate before creating them. No hosting resources have been created by this file.

Set secrets in Render, never in Git:

- `API_KEYS` (API service): use `YOUR_RANDOM_TOKEN:00000000-0000-0000-0000-000000000001`.
  Generate your own token, for example with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
- `OPENAI_API_KEY` (API and worker): your provider key. Other providers require
  updating `DEFAULT_LLM_PROVIDER` and their matching secret on both services.

Database and queue URLs are wired automatically. The API's pre-deploy command
runs migrations, including the default organization. Health checks use `/ready`.
The Docker image builds and serves the React dashboard on the API origin, so no
separate dashboard hosting or CORS configuration is required.

After deployment, verify `/health`, `/ready`, and `/docs`. Open `/` and enter only
your application bearer token (the part before the colon in `API_KEYS`). Never
enter your LLM provider key into the dashboard. In VS Code, set the extension's
API base URL to the deployed HTTPS origin and its API key to that same token.

For automated GitHub PR reviews, also configure `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` on both services, and `GITHUB_WEBHOOK_SECRET` on the API.
Follow `docs/GITHUB_APP.md` and use the webhook endpoint documented in `/docs`.
Pinecone memory remains optional; configure matching Pinecone and embedding
settings on both services if you enable it.
