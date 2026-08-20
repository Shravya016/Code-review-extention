# CodeReview AI

Real-time, LLM-assisted code review inside VS Code / Cursor. The extension sends the
active file (or selection) to the CodeReview API, shows findings in a sidebar, the
Problems panel, and a Markdown report, and applies suggested fixes through a diff
preview before writing any change.

## Requirements

This extension is a **client**. It needs the CodeReview backend API reachable at
`codereview.apiBaseUrl` (default `http://localhost:8000`). Start it with
`docker compose up` in `infra/compose`, and have an LLM provider configured
(Ollama / OpenAI / Mistral).

## Quick start

1. Start the backend and confirm `http://localhost:8000/health` is OK.
2. Run **CodeReview: Set API Key** and enter the key before the `:` in the backend's
   `API_KEYS` value (e.g. `devkey`).
3. Open a file and click the **▶ Review** icon in the editor title bar (or the
   `🔍 CodeReview` status-bar item).
4. Review findings, preview fixes, and apply or reject them.

## Key settings

- `codereview.apiBaseUrl` — backend URL (default `http://localhost:8000`)
- `codereview.provider` / `codereview.model` — optional overrides
- `codereview.reviewOnSave` — auto-review on save
- `codereview.publishDiagnostics` — show findings in the Problems panel

See `docs/EXTENSION.md` in the repository for the full workflow.
