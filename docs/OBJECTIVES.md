# Objectives

## Main objective

To design and implement an **LLM-powered automated code review system** that helps developers find security and quality problems in source code **inside the editor**, suggest **concrete code fixes**, and apply changes **only after preview and confirmation** — without replacing manual review entirely.

---

## Primary objectives

1. **Secure API access**  
   To authenticate every review request using an API key so only authorised clients (the VS Code / Cursor extension) can call the backend.

2. **One-click code submission from the IDE**  
   To let a developer review the active file or a selection using visible controls (status bar, editor title bar, sidebar) instead of only command-palette commands.

3. **Fast deterministic analysis**  
   To detect common, high-confidence issues with pattern matching before calling any language model — for example SQL injection via string concatenation, `eval`/`exec`, hardcoded secrets, modulo or division by zero (`% 0`), and bare `except:` in Python.

4. **LLM-assisted code review**  
   To send source code to a pluggable model (Ollama locally, or OpenAI / Mistral in the cloud) and return structured findings as JSON with title, severity, category, line number, and optional suggested fix.

5. **Reliable review pipeline**  
   To merge static and LLM findings, remove duplicate or ungrounded results, infer missing line numbers, and return a single consistent list of issues to the client.

6. **Actionable fix generation**  
   To produce **code-only** replacements using built-in templates first (SQL parameterisation, `int(input(...))` for numeric checks, modulo-by-zero correction, error-handling wraps) and use the LLM only when no template matches — always showing a **diff preview** before writing to the file.

7. **Clear reporting in the editor**  
   To display findings in a **Report Panel** with Apply / Generate / Reject buttons, editor line markers, quick-fix light-bulb actions, and an optional saved report under `.codereview/`.

8. **Developer control and safety**  
   To ensure the user can **reject** findings, **cancel** a fix after preview, and never have code changed silently by the tool.

---

## Secondary objectives (optional extensions)

9. **Persist review history**  
   To store reviews and findings in Postgres for later lookup and metrics.

10. **Metrics dashboard**  
    To show review counts, latency, and severity distribution for project leads.

11. **GitHub pull request integration**  
    To review changed files on a PR and post inline comments when the GitHub App is configured.

12. **Pre-push quality gate**  
    To run the same review pipeline from a git hook and block pushes that contain high or critical findings.

13. **Historical context (optional memory)**  
    To optionally retrieve similar past findings from a vector store to enrich the LLM prompt when enough history exists.

---

## Scope boundaries (what this project is not aiming to do)

- Replace enterprise tools such as SonarQube, Bandit, or Semgrep for organisation-wide policy enforcement.
- Guarantee zero false positives from the language model on every file and language.
- Run fully offline with **small** local models (e.g. 1B parameters) at the same quality as large code-specialised models.
- Require Pinecone, GitHub, or the dashboard for the **core demo** — the IDE review-and-fix path must work with API + extension + Ollama alone.

---

## Success criteria (how objectives are judged)

| # | Objective | Success criterion |
|---|---|---|
| 1 | Secure API access | Invalid key returns 401; valid key allows review |
| 2 | IDE submission | Review runs from a button without command palette |
| 3 | Static analysis | Known patterns (e.g. `% 0`, SQL concat) flagged on correct line |
| 4 | LLM review | Model returns parseable findings for sample files |
| 5 | Pipeline | Duplicates reduced; weak/hallucinated items filtered |
| 6 | Fix generation | Apply Fix updates code after preview; templates work without LLM |
| 7 | Reporting | Report Panel shows problem, current code, expected code |
| 8 | Safety | Reject and Cancel leave file unchanged |

---

## Mapping objectives to modules

| Objective | Module(s) |
|---|---|
| 1 | Authentication |
| 2 | VS Code Extension (Client) |
| 3 | Static Checker |
| 4 | LLM Review Engine |
| 5 | Review Pipeline |
| 6 | Fix Generator |
| 7 | Report & Decorations |
| 8 | Fix Generator + Report & Decorations |
| 9–13 | Database, Dashboard, GitHub Integration, Pre-push Hook, RAG (optional) |
