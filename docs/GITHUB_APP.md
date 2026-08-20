# GitHub App setup

## 1) Create and install the app

1. Create a **GitHub App** under org/user settings.
2. Configure:
   - **Webhook URL**: `https://<your-host>/v1/webhooks/github`
   - **Webhook secret**: same value as `GITHUB_WEBHOOK_SECRET`
3. Repository permissions:
   - Contents: Read
   - Pull requests: Read/Write
   - Checks: Read/Write
   - Metadata: Read
4. Subscribe to events:
   - `pull_request`
   - `ping`
5. Generate a private key (PEM) and install app on target repo.

## 2) Configure backend env

In `infra/compose/.env`:

```env
GITHUB_APP_ID=<your app id>
GITHUB_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=<same secret as app webhook config>
WEBHOOK_DEFAULT_ORG_ID=00000000-0000-0000-0000-000000000001
```

Restart services:

```bash
cd infra/compose
docker compose up --build -d
```

## 3) Optional installation mapping (recommended)

If you have multiple orgs, map installation IDs in DB:

```sql
INSERT INTO github_installations (installation_id, org_id, app_id)
VALUES (<installation_id>, '<org_uuid>'::uuid, <app_id>)
ON CONFLICT (installation_id) DO UPDATE
SET org_id = EXCLUDED.org_id, app_id = EXCLUDED.app_id;
```

For local compose:

```bash
docker compose exec postgres psql -U codereview -d codereview
```

## 4) End-to-end validation

### A) Validate webhook signature path first

Use the local signed webhook simulator:

```bash
python scripts/send_github_webhook.py \
  --secret "<GITHUB_WEBHOOK_SECRET>" \
  --owner "<owner>" \
  --repo "<repo>" \
  --pr-number <pr_number> \
  --installation-id <installation_id> \
  --head-sha <head_sha>
```

Expected API response:

- `{"review_id":"...","queued":true}`

### B) Watch processing

```bash
cd infra/compose
docker compose logs -f api worker
```

Expected worker behavior:

1. Fetch PR files from GitHub API
2. Run review pipeline on changed patches
3. Post PR review summary
4. Post inline comments (where line mapping succeeds)
5. Create check run `codereview/llm`

### C) Inspect review state

```bash
curl -H "Authorization: Bearer devkey" http://localhost:8000/v1/reviews/<review_id>
```

## Manual PR enqueue (alternative to webhook)

`POST /v1/reviews/pr` with bearer token:

```json
{
  "owner": "acme",
  "repo": "demo",
  "pr_number": 42,
  "installation_id": 123456,
  "head_sha": "abc..."
}
```

## Troubleshooting quick map

- `401 Invalid signature`: wrong webhook secret or missing `X-Hub-Signature-256`.
- `400 Unknown GitHub installation`: map installation in `github_installations` or set `WEBHOOK_DEFAULT_ORG_ID`.
- Worker logs show token exchange failure: check `GITHUB_APP_ID` and PEM formatting (`\n` escapes if in one line).
- No inline comments: finding paths/lines may not map to added lines in patch; summary comment should still appear.
