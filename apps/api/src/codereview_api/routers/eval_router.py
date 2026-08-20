from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import desc, select

from codereview_api.auth import AuthContext, require_bearer
from codereview_api.deps import DbSession, get_redis
from codereview_common.db.models import EvalRun
from codereview_common.queue.redis_queue import enqueue_job
from codereview_common.schemas import EvalRunRecord, EvalRunRequest, EvalRunsResponse

router = APIRouter(prefix="/eval", tags=["eval"])


@router.post("/run", status_code=status.HTTP_202_ACCEPTED)
async def run_eval(
    request: Request,
    body: EvalRunRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
):
    r = get_redis(request)
    await enqueue_job(
        r,
        {
            "type": "eval_run",
            "org_id": str(auth.org_id),
            "dataset": body.dataset,
            "model": body.model,
        },
    )
    return {"status": "queued"}


@router.get("/runs", response_model=EvalRunsResponse)
async def list_eval_runs(
    _auth: Annotated[AuthContext, Depends(require_bearer)],
    session: DbSession,
    limit: int = 20,
):
    capped = max(1, min(limit, 100))
    rows = await session.execute(select(EvalRun).order_by(desc(EvalRun.created_at)).limit(capped))
    runs = [
        EvalRunRecord(
            id=r.id,
            dataset=r.dataset,
            model=r.model,
            metrics=r.metrics_json,
            created_at=r.created_at,
        )
        for r in rows.scalars().all()
    ]
    return EvalRunsResponse(runs=runs)
