# Pre-Push Quality Gate

This repository includes a Git `pre-push` hook that runs LLM review on changed files and blocks push if high-severity findings are detected.

## What it does

When you run `git push`, the hook:

1. Detects commits being pushed.
2. Collects changed text files (up to `CODEREVIEW_MAX_FILES`).
3. Calls `POST /v1/reviews/realtime` for each file.
4. Blocks push when any finding severity matches `CODEREVIEW_BLOCK_SEVERITIES` (default: `high,critical`).
5. Writes report to `.codereview/pre-push-report.json`.

## Install

From repo root:

```bash
uv run python scripts/install_pre_push_hook.py
```

This copies `.githooks/pre-push` into `.git/hooks/pre-push`.

If the folder is not yet a git repo, bootstrap with your GitHub URL:

```bash
uv run python scripts/install_pre_push_hook.py --github-url https://github.com/<owner>/<repo>.git
```

You can also explicitly pass a path:

```bash
uv run python scripts/install_pre_push_hook.py --repo-path . --github-url https://github.com/<owner>/<repo>.git
```

## Required environment

Set these in your shell profile (or terminal session) before pushing:

```bash
export CODEREVIEW_API_KEY=devkey
```

Optional:

```bash
export CODEREVIEW_API_BASE=http://localhost:8000
export CODEREVIEW_PROVIDER=ollama
export CODEREVIEW_MODEL=llama3.2:1b
export CODEREVIEW_BLOCK_SEVERITIES=high,critical
export CODEREVIEW_MAX_FILES=20
export CODEREVIEW_MAX_FILE_BYTES=120000
```

## Behavior on failure

- Hook exits with code `2`, which blocks push.
- Terminal prints the top blocking findings and report location.

## Bypass (emergency only)

If absolutely needed:

```bash
git push --no-verify
```

Use sparingly and only when intentionally bypassing the gate.
