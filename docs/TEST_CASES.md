# Test Cases

The platform was tested end-to-end through the VS Code / Cursor extension against a local FastAPI backend. The seven scenarios below cover authentication, static analysis, LLM-assisted detection, deterministic fix templates, the diff preview safety gate, and the git workflow.

| # | Test Scenario | Input Command | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| 1 | **API Key Authentication** | Run `CodeReview: Set API Key` and enter `devkey` (the key configured in `API_KEYS`), then click `Review` | Review request authenticates and findings are returned | Findings returned, sidebar populated, no 401 | Pass |
| 2 | **Invalid API Key Rejection** | Set the API key to a random value `wrongkey` and click `Review` | Backend returns 401 and the extension shows a clear error toast | Toast: *"Unauthorized (401). Your API key does not match the server API_KEYS"* | Pass |
| 3 | **SQL Injection Detection (Static Check)** | Open `y.py` containing `q = "SELECT * FROM users WHERE id = " + user_id` and click `Review` | Static checker flags line 5 as high-severity SQL injection with CWE-89 | Finding raised on line 5, severity `high`, category `security` | Pass |
| 4 | **Apply Fix - SQL Injection (Deterministic Template)** | On the SQL-injection finding click `Apply Fix` in the Report Panel | Diff preview shows the line rewritten to use a `?` placeholder, after confirm the file is updated | Line 5 becomes `q = "SELECT * FROM users WHERE id = ?"  # pass (user_id,) to execute()`; finding removed | Pass |
| 5 | **Logic Bug Detection + Fix (Input Validation)** | Open `r.py` containing `age = input("Enter your age: ")` followed by `if age > 18:` and click `Review`, then `Apply Fix` on the Logic Bug finding | Findings include the comparison-type mismatch; Apply Fix wraps `age` in `int(input(...))` with `try/except ValueError` | `age = int(input(...))` wrapped in try/except, `name` left untouched | Pass |
| 6 | **Reject Finding** | In the Report Panel click `Reject` on any finding | Finding disappears from the panel and the source file is not modified | Card removed, sidebar count decreased, file unchanged on disk | Pass |
| 7 | **Diff Preview Cancellation** | Click `Apply Fix`, when the diff opens choose `Cancel` in the modal | No edit is applied; file content stays exactly as before | File on disk byte-identical, finding still present in panel | Pass |
| 8 | **Commit & Push from Non-Git Folder** | Click the `Commit & Push` button in a workspace that has no `.git` folder and provide a GitHub URL | Extension prompts to `Initialize Git Repo`, runs `git init`, sets `origin`, prompts for commit message, asks confirmation, then pushes | Repo initialised on `main`, commit created, push completed to provided remote | Pass |

---

## Manual end-to-end demo script (for the supervisor)

1. Start backend: `docker compose -f infra/compose/docker-compose.yml up`.
2. Press F5 to launch the Extension Development Host.
3. Set the API key (one-time): command palette → `CodeReview: Set API Key` → type `devkey`.
4. Open `y.py` → click the ▶ Review button in the status bar → wait for findings.
5. Open the Report Panel → click `Apply Fix` on the SQL-injection card → confirm in diff preview → observe the file change.
6. Click `Reject` on a different finding → observe its disappearance.
7. Make a small edit elsewhere, click `Commit & Push` → walk through the confirmations.
