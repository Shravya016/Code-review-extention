from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from pathlib import Path

import httpx
import redis.asyncio as redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from codereview_common.db.models import EvalRun, FindingRow, Review
from codereview_common.github.auth import get_installation_token
from codereview_common.github.client import GitHubRestClient
from codereview_common.queue.redis_queue import dequeue_blocking
from codereview_common.rag.pinecone_service import PineconeMemoryService
from codereview_common.rag.redaction import fingerprint_finding
from codereview_common.review.pipeline import RealtimeReviewPipeline
from codereview_common.schemas import RealtimeReviewRequest

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("codereview_worker")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _extract_added_lines_from_patch(patch: str) -> list[int]:
    added_lines: list[int] = []
    current_new_line = 0
    for line in patch.splitlines():
        if line.startswith("@@"):
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if m:
                current_new_line = int(m.group(1))
            continue
        if line.startswith("+") and not line.startswith("+++"):
            added_lines.append(current_new_line)
            current_new_line += 1
            continue
        if line.startswith("-") and not line.startswith("---"):
            continue
        current_new_line += 1
    return added_lines


def _closest_changed_line(changed_lines: list[int], requested_line: int | None) -> int | None:
    if not changed_lines:
        return None
    if not requested_line or requested_line <= 0:
        return changed_lines[0]
    best = min(changed_lines, key=lambda n: abs(n - requested_line))
    return best


def _finding_to_inline_comment(
    finding,
    *,
    changed_lines: list[int],
    head_sha: str,
) -> dict | None:
    if not finding.path:
        return None
    line = _closest_changed_line(changed_lines, finding.start_line)
    if not line:
        return None
    body = f"**{finding.title}** ({finding.severity})\n\n{finding.detail}"
    if finding.suggested_fix:
        body += f"\n\nSuggested fix:\n```suggestion\n{finding.suggested_fix[:5000]}\n```"
    return {
        "path": finding.path,
        "line": line,
        "side": "RIGHT",
        "commit_id": head_sha,
        "body": body[:65000],
    }


async def process_pr_job(
    session,
    client: httpx.AsyncClient,
    pipeline: RealtimeReviewPipeline,
    job: dict,
) -> None:
    review_id = uuid.UUID(job["review_id"])
    res = await session.execute(select(Review).where(Review.id == review_id))
    review = res.scalar_one_or_none()
    if not review:
        logger.error("Review %s not found", review_id)
        return

    review.status = "running"
    await session.commit()

    owner = job["owner"]
    repo = job["repo"]
    pr_number = int(job["pr_number"])
    installation_id = int(job["installation_id"])
    app_id = int(os.environ.get("GITHUB_APP_ID", "0"))
    pem = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")

    findings_merged: list = []
    meta: dict = {}

    try:
        if app_id and pem:
            token = await get_installation_token(
                client, app_id=app_id, installation_id=installation_id, private_key_pem=pem
            )
            gh = GitHubRestClient(token)
            files = await gh.get_pull_request_files(client, owner, repo, pr_number)
            patch_files = [f for f in files if f.get("patch")]
            line_index: dict[str, list[int]] = {
                f.get("filename", ""): _extract_added_lines_from_patch(str(f.get("patch") or ""))
                for f in patch_files
            }
            for f in patch_files[:8]:
                filename = str(f.get("filename") or "")
                patch = str(f.get("patch") or "")
                req = RealtimeReviewRequest(
                    org_id=review.org_id,
                    repo_id=review.repo_id,
                    language="diff",
                    path=filename,
                    content=patch[:12000],
                    enable_memory=True,
                )
                findings, meta = await pipeline.run(client, req)
                findings_merged.extend(findings)

            if findings_merged:
                review.model = meta.get("model")
                review.prompt_versions = meta.get("prompt_versions")
                review.latency_ms = meta.get("latency_ms")
                for f in findings_merged:
                    fp = fingerprint_finding(f.path, f.start_line, f.title)
                    session.add(
                        FindingRow(
                            review_id=review.id,
                            category=f.category.value,
                            severity=f.severity.value,
                            path=f.path,
                            start_line=f.start_line,
                            end_line=f.end_line,
                            fingerprint=fp,
                            payload_json=f.model_dump(mode="json"),
                        )
                    )
                head_sha = job.get("head_sha") or ""
                body = "## Automated LLM code review\n\n"
                body += "\n".join(
                    f"- **{f.title}** ({f.severity}): {f.detail}" for f in findings_merged[:40]
                )
                comments = []
                if head_sha:
                    for finding in findings_merged[:25]:
                        changed_lines = line_index.get(str(finding.path or ""))
                        if not changed_lines:
                            continue
                        c = _finding_to_inline_comment(
                            finding, changed_lines=changed_lines, head_sha=head_sha
                        )
                        if c:
                            comments.append(c)
                if head_sha:
                    try:
                        await gh.create_check_run(
                            client,
                            owner,
                            repo,
                            head_sha,
                            "codereview/llm",
                            body[:65000],
                        )
                    except Exception as e:
                        logger.warning("check run: %s", e)
                try:
                    await gh.post_pull_request_review(
                        client, owner, repo, pr_number, body=body[:65000], comments=comments
                    )
                except Exception as e:
                    logger.warning("PR review comment: %s", e)
            else:
                logger.info("No patch hunks found for PR %s/%s#%s", owner, repo, pr_number)
        else:
            logger.warning("GITHUB_APP_ID or private key missing; skipping GitHub fetch")

        review.status = "completed"
        await session.commit()
    except Exception:
        logger.exception("PR job failed")
        review.status = "failed"
        await session.commit()


async def process_eval_job(
    session, client: httpx.AsyncClient, pipeline: RealtimeReviewPipeline, job: dict
) -> None:
    golden = _repo_root() / "eval" / "golden.jsonl"
    if not golden.exists():
        logger.error("Missing %s", golden)
        return
    lines = [ln for ln in golden.read_text(encoding="utf-8").splitlines() if ln.strip()]
    rows = [json.loads(line) for line in lines]
    hits = 0
    model = job.get("model")
    for row in rows:
        expected = set(row.get("expected_cwe") or [])
        req = RealtimeReviewRequest(
            org_id=uuid.UUID(job["org_id"]),
            language=row.get("language", "python"),
            path=row.get("path"),
            content=row["code"],
            model=model,
        )
        findings, _meta = await pipeline.run(client, req)
        cwe_hits = {f.cwe_id for f in findings if f.cwe_id}
        if expected & cwe_hits:
            hits += 1
    metrics = {"cases": len(rows), "cwe_recall_approx": hits / len(rows) if rows else 0.0}
    model_name = job.get("model") or pipeline.default_model or pipeline.default_model_for(
        pipeline.default_provider
    )
    session.add(
        EvalRun(
            dataset=job["dataset"],
            model=str(model_name),
            metrics_json=metrics,
        )
    )
    await session.commit()


async def worker_loop() -> None:
    database_url = os.environ["DATABASE_URL"]
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    engine = create_async_engine(database_url, echo=False)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    r = redis.from_url(redis_url, decode_responses=True)

    emb_dim = os.environ.get("EMBEDDING_DIMENSION")
    memory = PineconeMemoryService(
        os.environ.get("PINECONE_API_KEY"),
        os.environ.get("PINECONE_INDEX"),
        embedding_provider=os.environ.get("EMBEDDING_PROVIDER"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        ollama_base_url=os.environ.get("OLLAMA_BASE_URL"),
        embedding_model=os.environ.get("EMBEDDING_MODEL"),
        embedding_dimension=int(emb_dim) if emb_dim else None,
    )
    m = os.environ.get("DEFAULT_LLM_MODEL")
    default_model = m.strip() if m and m.strip() else None
    pipeline = RealtimeReviewPipeline(
        default_provider=os.environ.get("DEFAULT_LLM_PROVIDER", "openai"),
        default_model=default_model,
        openai_key=os.environ.get("OPENAI_API_KEY"),
        mistral_key=os.environ.get("MISTRAL_API_KEY"),
        ollama_base=os.environ.get("OLLAMA_BASE_URL"),
        memory=memory,
    )

    async with httpx.AsyncClient() as client:
        while True:
            job = await dequeue_blocking(r, timeout=10)
            if not job:
                continue
            jt = job.get("type")
            async with factory() as session:
                try:
                    if jt == "pr_review":
                        await process_pr_job(session, client, pipeline, job)
                    elif jt == "eval_run":
                        await process_eval_job(session, client, pipeline, job)
                    else:
                        logger.warning("Unknown job type %s", jt)
                except Exception:
                    logger.exception("Job failed")


def main() -> None:
    asyncio.run(worker_loop())


if __name__ == "__main__":
    main()
