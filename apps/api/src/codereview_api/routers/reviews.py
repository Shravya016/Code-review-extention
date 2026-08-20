from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from codereview_api.auth import AuthContext, require_bearer
from codereview_api.deps import DbSession, Pipeline, get_http, get_redis
from codereview_api.schemas_extra import PrEnqueueRequest
from codereview_common.db.models import FindingRow, Review
from codereview_common.queue.redis_queue import enqueue_job
from codereview_common.rag.redaction import fingerprint_finding
from codereview_common.review.pipeline import RealtimeReviewPipeline
from codereview_common.schemas import Finding, RealtimeReviewRequest, ReviewResult

router = APIRouter(prefix="/reviews", tags=["reviews"])


def _merge_auth_org(body: RealtimeReviewRequest, auth: AuthContext) -> RealtimeReviewRequest:
    data = body.model_dump()
    data["org_id"] = body.org_id or auth.org_id
    return RealtimeReviewRequest(**data)


@router.post("/realtime", response_model=ReviewResult)
async def realtime_review(
    request: Request,
    body: RealtimeReviewRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
    session: DbSession,
    pipeline: Pipeline,
):
    req = _merge_auth_org(body, auth)
    http = get_http(request)
    try:
        findings, meta = await pipeline.run(http, req)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    except httpx.HTTPStatusError as e:
        provider_body = e.response.text[:500] if e.response is not None else ""
        detail = f"LLM provider HTTP error: {e.response.status_code} {provider_body}".strip()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail) from e
    except httpx.ReadTimeout as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Ollama/LLM read timeout. Ensure Ollama is running (`ollama serve`), model is pulled "
            "(`ollama pull llama3.2:3b`), and OLLAMA_BASE_URL=http://host.docker.internal:11434/v1. "
            "Try a smaller model if RAM is limited.",
        ) from e
    except httpx.ConnectError as e:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Cannot connect to Ollama. Start Ollama on the host and verify OLLAMA_BASE_URL in infra/compose/.env.",
        ) from e

    review = Review(
        org_id=req.org_id or auth.org_id,
        repo_id=req.repo_id,
        source="ide",
        status="completed",
        model=meta.get("model"),
        prompt_versions=meta.get("prompt_versions"),
        latency_ms=meta.get("latency_ms"),
        token_usage_json=meta.get("token_usage"),
    )
    session.add(review)
    await session.flush()

    for f in findings:
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
    await session.commit()

    return ReviewResult(
        review_id=str(review.id),
        model=str(meta.get("model", "")),
        prompt_versions=list(meta.get("prompt_versions") or []),
        findings=findings,
        token_usage=meta.get("token_usage"),
        latency_ms=meta.get("latency_ms"),
        llm_warning=meta.get("llm_warning"),
    )


async def _sse_stream(
    request: Request,
    pipeline: RealtimeReviewPipeline,
    req: RealtimeReviewRequest,
) -> AsyncIterator[bytes]:
    http = get_http(request)
    buf: list[str] = []
    async for chunk in pipeline.stream(http, req):
        buf.append(chunk)
        yield f"data: {json.dumps({'token': chunk})}\n\n".encode()
    full = "".join(buf)
    yield f"data: {json.dumps({'done': True, 'raw': full})}\n\n".encode()


@router.post("/realtime/stream")
async def realtime_stream(
    request: Request,
    body: RealtimeReviewRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
    pipeline: Pipeline,
):
    req = _merge_auth_org(body, auth)
    return StreamingResponse(
        _sse_stream(request, pipeline, req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/pr", status_code=status.HTTP_202_ACCEPTED)
async def enqueue_pr(
    request: Request,
    payload: PrEnqueueRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
    session: DbSession,
):
    review = Review(
        org_id=auth.org_id,
        repo_id=None,
        source="pr",
        pr_number=payload.pr_number,
        commit_sha=payload.head_sha,
        status="queued",
    )
    session.add(review)
    await session.flush()
    await session.commit()

    r = get_redis(request)
    await enqueue_job(
        r,
        {
            "type": "pr_review",
            "review_id": str(review.id),
            "org_id": str(auth.org_id),
            "owner": payload.owner,
            "repo": payload.repo,
            "pr_number": payload.pr_number,
            "installation_id": payload.installation_id,
            "head_sha": payload.head_sha,
        },
    )
    return {"review_id": str(review.id), "status": "queued"}


@router.get("/{review_id}")
async def get_review(
    review_id: uuid.UUID,
    auth: Annotated[AuthContext, Depends(require_bearer)],
    session: DbSession,
):
    stmt = (
        select(Review)
        .where(Review.id == review_id, Review.org_id == auth.org_id)
        .options(selectinload(Review.findings))
    )
    res = await session.execute(stmt)
    review = res.scalar_one_or_none()
    if not review:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Review not found")
    findings: list[Finding] = []
    for row in review.findings:
        findings.append(Finding.model_validate(row.payload_json))
    return {
        "id": str(review.id),
        "status": review.status,
        "source": review.source,
        "pr_number": review.pr_number,
        "findings": [f.model_dump(mode="json") for f in findings],
    }
