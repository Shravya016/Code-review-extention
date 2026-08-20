from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status

from codereview_api.auth import AuthContext, require_bearer
from codereview_api.deps import get_http, get_memory
from codereview_common.schemas import MemorySearchRequest, MemoryUpsertRequest

router = APIRouter(prefix="/memory", tags=["memory"])


@router.post("/search")
async def memory_search(
    request: Request,
    body: MemorySearchRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
):
    if body.org_id != auth.org_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org mismatch")
    mem = get_memory(request)
    http = get_http(request)
    hits = await mem.query_similar(body.org_id, body.repo_id, body.query, body.top_k, http)
    return {"hits": hits}


@router.post("/upsert")
async def memory_upsert(
    request: Request,
    body: MemoryUpsertRequest,
    auth: Annotated[AuthContext, Depends(require_bearer)],
):
    if body.org_id != auth.org_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org mismatch")
    mem = get_memory(request)
    http = get_http(request)
    n = await mem.upsert_findings(
        body.org_id,
        body.repo_id,
        body.review_id,
        "unknown",
        None,
        body.findings,
        http,
    )
    return {"upserted": n}
