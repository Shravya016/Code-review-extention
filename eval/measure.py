"""Measure review latency and detection accuracy (true positives vs false positives).

Runs the real RealtimeReviewPipeline over a labelled dataset of buggy and clean
files and reports:

  * Latency: mean / p50 / p95 / min / max per review (from pipeline meta).
  * Detection accuracy on buggy files (recall / true-positive rate).
  * False-positive rate on clean files.
  * Attribution of each finding to the deterministic static checker vs the LLM,
    so the LLM's own contribution can be separated from regex rules.

Usage (from repo root, using the project venv so codereview_common is importable):

    # Local Ollama (matches infra/compose/.env defaults)
    set DEFAULT_LLM_PROVIDER=ollama
    set DEFAULT_LLM_MODEL=llama3:latest
    set OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
    .venv\\Scripts\\python eval\\measure.py

    # OpenAI
    set DEFAULT_LLM_PROVIDER=openai
    set DEFAULT_LLM_MODEL=gpt-4o-mini
    set OPENAI_API_KEY=sk-...
    .venv\\Scripts\\python eval\\measure.py

Add --static-only to benchmark the deterministic checker without any LLM call
(useful as a baseline and to confirm latency of the non-LLM path).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import uuid
from pathlib import Path

import httpx

from codereview_common.review.pipeline import dedupe_findings
from codereview_common.review.static_checks import run_static_checks
from codereview_common.schemas import Finding, RealtimeReviewRequest, Severity

ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "measure_dataset.jsonl"

ACTIONABLE = {Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL}

# Never route localhost Ollama through a corporate/system HTTP proxy.
for _proxy_var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(_proxy_var, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"


def load_rows() -> list[dict]:
    lines = [ln for ln in DATASET.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


def build_pipeline():
    from codereview_common.review.pipeline import RealtimeReviewPipeline

    return RealtimeReviewPipeline(
        default_provider=os.getenv("DEFAULT_LLM_PROVIDER", "ollama"),
        default_model=os.getenv("DEFAULT_LLM_MODEL", "llama3:latest"),
        openai_key=os.getenv("OPENAI_API_KEY"),
        mistral_key=os.getenv("MISTRAL_API_KEY"),
        ollama_base=os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"),
        memory=None,
    )


def _finding_key(f: Finding) -> tuple:
    return (f.category.value, f.start_line, f.title.strip().lower()[:24])


def classify_origin(final: list[Finding], static: list[Finding]) -> tuple[list[Finding], list[Finding]]:
    """Split final findings into (static-origin, llm-origin) using category+line+title."""
    static_keys = {_finding_key(s) for s in static}
    static_lines = {(s.category.value, s.start_line) for s in static}
    static_out, llm_out = [], []
    for f in final:
        if _finding_key(f) in static_keys or (f.category.value, f.start_line) in static_lines:
            static_out.append(f)
        else:
            llm_out.append(f)
    return static_out, llm_out


def matches_expected(row: dict, findings: list[Finding]) -> bool:
    expected_cwe = {c.upper() for c in (row.get("expected_cwe") or [])}
    found_cwe = {(f.cwe_id or "").upper() for f in findings if f.cwe_id}
    if expected_cwe and (expected_cwe & found_cwe):
        return True
    keywords = [k.lower() for k in (row.get("match_keywords") or [])]
    if keywords:
        blob = " ".join(f"{f.title} {f.detail}".lower() for f in findings)
        if any(k in blob for k in keywords):
            return True
    return False


def actionable(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.severity in ACTIONABLE]


def pct(n: int, d: int) -> str:
    return f"{(100.0 * n / d):.1f}%" if d else "n/a"


async def run(static_only: bool) -> dict:
    rows = load_rows()
    pipeline = None if static_only else build_pipeline()
    per_case = []
    warnings = 0

    # trust_env=False so localhost Ollama is not routed through any HTTP(S)_PROXY
    # picked up from the environment (which disconnects on 127.0.0.1 requests).
    async with httpx.AsyncClient(trust_env=False) as client:
        for row in rows:
            req = RealtimeReviewRequest(
                org_id=uuid.uuid4(),
                language=row.get("language", "python"),
                path=row.get("path"),
                content=row["code"],
            )
            static = run_static_checks(req.content, language=req.language, path=req.path)

            if static_only:
                final = dedupe_findings(static)
                latency_ms = 0
                meta = {}
            else:
                final, meta = await pipeline.run(client, req)
                latency_ms = int(meta.get("latency_ms", 0))
                if meta.get("llm_warning"):
                    warnings += 1

            static_f, llm_f = classify_origin(final, static)
            per_case.append(
                {
                    "id": row["id"],
                    "label": row["label"],
                    "latency_ms": latency_ms,
                    "detected": matches_expected(row, final),
                    "detected_by_llm": matches_expected(row, llm_f),
                    "detected_by_static": matches_expected(row, static),
                    "n_actionable": len(actionable(final)),
                    "n_actionable_llm": len(actionable(llm_f)),
                    "n_actionable_static": len(actionable(static_f)),
                }
            )
            tag = row["label"].upper()
            print(f"  [{tag:5}] {row['id']:22} {latency_ms:>7} ms  detected={per_case[-1]['detected']}")

    buggy = [c for c in per_case if c["label"] == "buggy"]
    clean = [c for c in per_case if c["label"] == "clean"]
    lat = [c["latency_ms"] for c in per_case] or [0]

    tp = sum(1 for c in buggy if c["detected"])
    tp_llm = sum(1 for c in buggy if c["detected_by_llm"])
    tp_static = sum(1 for c in buggy if c["detected_by_static"])
    fp_files = sum(1 for c in clean if c["n_actionable"] > 0)
    fp_files_llm = sum(1 for c in clean if c["n_actionable_llm"] > 0)

    summary = {
        "provider": os.getenv("DEFAULT_LLM_PROVIDER", "ollama") if not static_only else "static-only",
        "model": os.getenv("DEFAULT_LLM_MODEL", "llama3:latest") if not static_only else "n/a",
        "cases": len(per_case),
        "buggy": len(buggy),
        "clean": len(clean),
        "llm_warnings": warnings,
        "latency_ms": {
            "mean": round(statistics.mean(lat), 1),
            "p50": round(statistics.median(lat), 1),
            "p95": round(sorted(lat)[max(0, int(0.95 * len(lat)) - 1)], 1),
            "min": min(lat),
            "max": max(lat),
        },
        "detection": {
            "system_recall": {"tp": tp, "n": len(buggy), "rate": pct(tp, len(buggy))},
            "llm_recall": {"tp": tp_llm, "n": len(buggy), "rate": pct(tp_llm, len(buggy))},
            "static_recall": {"tp": tp_static, "n": len(buggy), "rate": pct(tp_static, len(buggy))},
        },
        "false_positives": {
            "system_fp_files": {"fp": fp_files, "n": len(clean), "rate": pct(fp_files, len(clean))},
            "llm_fp_files": {"fp": fp_files_llm, "n": len(clean), "rate": pct(fp_files_llm, len(clean))},
        },
        "per_case": per_case,
    }
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--static-only", action="store_true", help="Skip LLM; benchmark static checker only")
    ap.add_argument("--out", default=str(ROOT / "measure_results.json"))
    args = ap.parse_args()

    print("=== measure.py v2 (proxy-safe build) ===")
    print(f"Running measurement over {DATASET.name} (static_only={args.static_only})...")
    summary = asyncio.run(run(args.static_only))

    print("\n=== SUMMARY ===")
    print(f"Provider/model : {summary['provider']} / {summary['model']}")
    print(f"Cases          : {summary['cases']} ({summary['buggy']} buggy, {summary['clean']} clean)")
    if summary["llm_warnings"]:
        print(f"LLM warnings   : {summary['llm_warnings']} (LLM unreachable/timeout on these -> static only)")
    lm = summary["latency_ms"]
    print(f"Latency (ms)   : mean={lm['mean']} p50={lm['p50']} p95={lm['p95']} min={lm['min']} max={lm['max']}")
    d = summary["detection"]
    print(f"Recall (system): {d['system_recall']['rate']}  ({d['system_recall']['tp']}/{d['system_recall']['n']} buggy files flagged)")
    print(f"Recall (LLM)   : {d['llm_recall']['rate']}  (LLM-attributed only)")
    print(f"Recall (static): {d['static_recall']['rate']}  (deterministic checker only)")
    fp = summary["false_positives"]
    print(f"False positives: {fp['system_fp_files']['rate']} of clean files flagged (system); {fp['llm_fp_files']['rate']} (LLM-attributed)")

    Path(args.out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nFull results written to {args.out}")


if __name__ == "__main__":
    main()
