# Methodology

This chapter describes the approach followed to design, build, and validate the **LLM-Powered Automated Code Review Platform**. The work was carried out as an **iterative software-engineering project** with short build–test–refine cycles, supported by lightweight requirements analysis and continuous evaluation against real code samples.

---

## 1. Software development model

An **iterative incremental model** was adopted instead of a single waterfall pass. Each cycle produced a runnable increment of the system - for example, "static checker working end-to-end", then "LLM integration", then "VS Code extension UI", and so on. The advantages observed:

- Working software was available from week one, allowing feedback to drive subsequent priorities.
- Issues such as model hallucination and prompt drift were caught early when the system was small.
- Optional modules (GitHub PR reviewer, dashboard, RAG memory) could be added on top without rewriting the core.

Each iteration followed the loop:

```
   Plan -> Design -> Implement -> Test -> Review -> Refine
```

---

## 2. Requirements analysis

The high-level functional requirements were derived from typical developer pain points around manual code review:

1. Review a file from inside the editor with a single click.
2. Detect both deterministic issues (e.g. `eval`, SQL injection) and higher-level issues that need a model (e.g. logic bugs, missing validation).
3. Show findings with severity, location, and a concrete fix.
4. Apply the fix with a preview, so the developer remains in control.
5. Persist results so historical analytics are possible.
6. Optionally extend the same pipeline to pull requests on GitHub.

Non-functional requirements:

| Concern | Decision |
|---|---|
| Privacy | Code never leaves the local network unless the developer opts in to a cloud LLM. PII is scrubbed before any vector upsert. |
| Latency | Real-time path target < 30 s on a small file with a local model. |
| Extensibility | LLM provider, prompt template, and static checks are pluggable. |
| Reliability | Static checker runs first so even a broken LLM still produces useful output. |
| Usability | All actions must be reachable by a button, not just the command palette. |

---

## 3. System design

A **monorepo** with three top-level domains was chosen:

- `apps/` - runnable services (API, async worker, dashboard)
- `packages/` - shared libraries (Python common, prompts, contracts, SDK, VS Code extension)
- `infra/`, `scripts/`, `docs/` - supporting artefacts

A high-level architecture diagram and the per-module breakdown are provided in [MODULES.md](MODULES.md). The system has 8 core modules and 4 optional add-ons.

The system is organised in three layers:

1. **Client layer** - the VS Code / Cursor extension. Pure TypeScript.
2. **Service layer** - the FastAPI backend and the async worker. Pure Python.
3. **Asset layer** - prompts (Jinja2), OpenAPI contracts, SQL migrations.

Communication is contract-first via an OpenAPI 3.1 specification under `packages/contracts/openapi.yaml`.

---

## 4. Tools and technologies

| Concern | Tool |
|---|---|
| Backend language | Python 3.12 |
| Backend framework | FastAPI + Pydantic + SQLAlchemy |
| Database | Postgres (via Docker Compose) |
| Queue | Redis |
| Vector store (optional) | Pinecone |
| LLM runtimes | Ollama (local), OpenAI, Mistral |
| IDE extension language | TypeScript with the VS Code Extension API |
| Frontend dashboard | React 18 + Vite |
| Package management | `uv` for Python, `pnpm` for TypeScript |
| Containerisation | Docker Compose for local development |
| Database migrations | Alembic |
| Testing | `pytest` for Python, `vscode-test` for the extension |
| Version control | Git, with a custom pre-push hook |

---

## 5. Implementation methodology

The implementation was broken into five phases, each ending with a demoable result.

### Phase 1 - Core API and pipeline

- Set up the FastAPI service skeleton, authentication via bearer API key, and the OpenAPI contract.
- Designed the Pydantic schemas: `ReviewRequest`, `Finding`, `ReviewResponse`.
- Wrote the **static checker** (`packages/python-common/.../static_checks.py`) with regex-based detectors for `eval`, hardcoded secrets, SQL string concatenation, bare `except:`.
- Connected an LLM provider (`OpenAIProvider`, later `OllamaProvider`) behind a single interface, and ran the first end-to-end review.

### Phase 2 - Review pipeline robustness

- Designed a tolerant parser: accepts strict JSON from strong models and Markdown-shaped output from weaker models.
- Added grounding filters: a finding is dropped if it has no line number, no fix, no CWE/OWASP id, and no reference.
- Implemented family-based deduplication so two near-duplicate findings collapse into the most specific one.
- Added line-number inference for findings the model emitted without a `start_line`.

### Phase 3 - VS Code / Cursor extension

- Wired the extension to call the API, mapped findings to VS Code `Diagnostic`s.
- Added a sidebar webview for findings, a status-bar button, editor-title icons, a context menu entry.
- Built the rich **Report Panel** webview with real HTML buttons for Apply / Generate / Reject.
- Registered a `CodeActionProvider` so the standard yellow light-bulb offers per-line fixes.
- Implemented **deterministic fix templates** for the cases the local LLM consistently failed on:
  - SQL injection by string concatenation
  - `input()` paired with numeric comparison (wraps with `int(...)` and `try/except`)
  - bare `except:` -> `except Exception:`
  - hardcoded secrets -> read from environment
  - missing error handling -> wrap block in `try/except`
- LLM is used as a fallback when no template matches.
- Every code modification goes through a **diff preview** that the developer must confirm.

### Phase 4 - Persistence, dashboard, optional add-ons

- Added SQLAlchemy models for `Review`, `Finding`, `Organisation`, `Installation`, `EvalRun`.
- Wrote Alembic migrations and seeded Docker Compose with Postgres and Redis.
- Built the React dashboard for review throughput, P95 latency, and severity histogram.
- Added the GitHub App pieces (webhook verification, JWT to installation-token exchange, async worker that posts inline PR comments).
- Added the pre-push git hook that reuses the same review pipeline as a quality gate.

### Phase 5 - Evaluation, hardening, documentation

- Iterated on the prompt (`packages/prompts/system.reviewer.v1.txt` and `user.realtime.v1.j2`) until the LLM output passed the grounding and parsing filters reliably.
- Added retry logic in the Ollama provider so it survives "model requires more memory" errors by trimming the prompt.
- Hardened the commit-and-push flow to gracefully `git init` and prompt for the remote URL when the workspace is not yet a git repository.
- Wrote architecture, security, deployment, and runbook documentation under `docs/`.

---

## 6. Testing strategy

| Level | What is tested | Where |
|---|---|---|
| Unit | Static-check regexes, redaction, embedding shape, GitHub JWT | `packages/python-common/tests/` |
| Integration | API readiness with DB + Redis | `apps/api/tests/test_ready_integration.py` |
| Component | PR diff -> changed-line mapper | `apps/worker/tests/test_pr_line_mapping.py` |
| Manual | VS Code extension UX end-to-end (Review -> Report Panel -> Apply Fix -> diff preview -> commit) | Run F5 in VS Code |
| Smoke | Local Python files such as `y.py`, `r.py` containing SQL injection, missing input validation, error handling gaps - used as repeatable demos. |

---

## 7. Evaluation methodology

The evaluation followed three angles:

1. **Correctness of findings** - does each finding point to a real issue, on the right line?
2. **Quality of fixes** - does Apply Fix yield code that compiles and removes the issue?
3. **Usability** - can a developer reach every action without the command palette?

For 1 and 2, a set of hand-crafted Python snippets covering 12 known issue categories was used. Each snippet was reviewed by the system, the resulting fix was applied, and the patched file was checked for syntactic validity and absence of the original issue.

For 3, the click-target inventory was used as a checklist: status-bar buttons, editor-title icons, sidebar header icons, sidebar webview buttons, Report Panel buttons, right-click menu, light-bulb. All twelve actions are exposed via at least one button or icon.

---

## 8. Limitations of the methodology

- The LLM coverage depends on the chosen model. Small local models (e.g. `llama3.2:1b`) miss issues that a larger model (`qwen2.5-coder:7b`) catches.
- The deterministic fix engine covers common Python and JS/TS patterns. Languages not in the template set fall back entirely to the LLM.
- The vector memory module is implemented but its impact is small until a meaningful history of past findings has been collected.
- Evaluation was not run on a third-party benchmark such as SWE-Bench; the system was evaluated on internal handcrafted snippets and demo files.

---

## 9. Summary

The methodology combined an **iterative incremental development model**, a **layered modular architecture**, and a **two-stage analysis strategy** (deterministic checks + LLM) wrapped in a usability-first IDE experience. Every code modification is gated by a diff preview, every action is reachable by a button, and the system runs end-to-end with either a free local model or a hosted commercial model.
