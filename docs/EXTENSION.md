# VS Code extension

## Development

```bash
cd packages/extension
pnpm install
pnpm run compile
```

Launch **Run and Debug** → "Extension" in VS Code/Cursor to open an Extension Development Host.

## First-time setup

1. Start the API (`docker compose up` in `infra/compose`) and confirm http://localhost:8000/health returns OK.
2. Set `codereview.apiBaseUrl` to `http://localhost:8000` (default).
3. Run command **CodeReview: Set API Key** and enter **`devkey`** only (the part before `:` in `API_KEYS=devkey:00000000-...`). Not the UUID.
4. Run **CodeReview: Review File** on an open editor (first Ollama review can take 1–3 minutes).
5. Optional: enable `codereview.reviewOnSave` for automatic review on each save.
6. By default, findings are written to Markdown files under `.codereview/` in your workspace.

## Click targets (no command palette needed)

After installing, these click-able buttons are available everywhere — you no longer need `Ctrl+Shift+P`:

- **Editor title bar** (top-right when a file is open): Play icon = Review Active File, Wrench = Fix Current Line, Go-to-File = Open Latest Findings Report.
- **Status bar** (bottom-left): `🔍 CodeReview` → click to review the active file.
- **Right-click in editor**: `CodeReview: Review Active File` and `CodeReview: Fix Current Line` near the top of the context menu.
- **Yellow light bulb** on any line covered by a finding: click it (or press `Ctrl+.`) to choose **Apply fix**, **Generate fix**, or **Reject** for that finding.
- **Colored line decorations**: critical = red, high = orange, medium = yellow, low/info = blue/gray. Trailing text reads "click bulb to fix".
- **CodeReview Findings sidebar view title bar**: Review · Apply All · Open Report · Commit & Push · Set API Key.
- **CodeLens buttons inside `.findings.md` reports**: top-of-file `Apply All Fixes · Review Again · Open Source File`, and above each finding heading `Apply Fix · Generate Fix · Reject`.

Results appear in:

- **CodeReview Findings** view in the Explorer sidebar with:
  - top buttons: Review Active File / Fix Current Line / Apply Suggested Fixes / Commit & Push / Set API Key / Clear API Key
  - per-finding actions: **Accept** / **Reject**
  - expected code block shown when suggestion exists
  - persistent findings list with severity/category/path metadata
- **Markdown findings files** (default) in `.codereview/*.findings.md`
- **Problems** panel (squiggles under lines)
- Notification toasts for errors (e.g. 401 = wrong API key)
- Automatic reruns on save (if enabled)

You can control output behavior in settings:

- `codereview.publishDiagnostics` (default `false`)
- `codereview.writeFindingsToFile` (default `true`)
- `codereview.findingsOutputDir` (default `.codereview`)
- `codereview.openFindingsFileAfterReview` (default `true`)

## Suggested-fix workflow

1. Run **CodeReview: Review Active File**.
2. The generated `.codereview/<file>.findings.md` report opens automatically. Each finding section shows:
   - **Problem** description
   - **Current code** snippet pulled from your file (with `>` markers on flagged lines)
   - **Expected code** block (the suggested replacement)
3. **CodeLens buttons** appear directly above each finding heading in the report (no need to click markdown links):
   - **Apply Fix** — applies the suggested code (auto-generates if missing) after a diff preview
   - **Generate Fix** — asks the LLM for a concrete code-only replacement and applies it
   - **Reject** — removes the finding from the report
4. A top-of-report CodeLens row offers:
   - **Apply All Fixes** — runs Apply Fix on every finding sequentially
   - **Review Again** — re-runs review on the source file
   - **Open Source File** — jumps back to the source
5. Alternative: place cursor on a finding line in the source and run **Fix Current Line** (also in editor context menu).
6. The extension writes `.codereview/*.findings.json` sidecar files so the buttons keep working after a restart.
7. If you don't see CodeLenses, ensure VS Code setting `editor.codeLens` is **enabled** for Markdown files. As a fallback, run **CodeReview: Run Report Action At Cursor** with cursor on the `Actions:` line.
8. Every fix application shows a **diff preview** before writing. Confirm with **Apply** or **Cancel**.
9. When you're satisfied, click **Commit & Push** in the sidebar (or run `CodeReview: Commit and Push Changes`) — it always asks for confirmation and the remote URL.

If no `origin` remote exists, **Commit & Push** prompts for a GitHub URL and configures `origin` automatically before pushing.

You can also right-click inside editor and run **CodeReview: Fix Current Line** from context menu.

If you see endless loading, check Docker logs for `401` on `/v1/reviews/realtime` and re-run **CodeReview: Clear API Key** then **Set API Key**.

Uncheck **Breakpoints → Caught Exceptions** in the Run view if the debugger keeps stopping on unrelated Cursor/git errors.

## Publishing

1. Obtain a Marketplace publisher.
2. Install `@vscode/vsce` and run `vsce package` from `packages/extension`.
3. Ensure `readme` and `license` fields are populated before publish.

## Privacy

The extension sends the selected buffer or entire active document to your configured API. Do not use on repositories containing secrets you cannot share with the configured backend.
