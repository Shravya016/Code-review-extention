from __future__ import annotations

from fastapi import APIRouter, Request, Response
from sqlalchemy import text

router = APIRouter(tags=["health"])


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/ready")
async def ready(request: Request, response: Response):
    ok = True
    try:
        async with request.app.state.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        ok = False
    try:
        await request.app.state.redis.ping()
    except Exception:
        ok = False
    if not ok:
        response.status_code = 503
        return {"status": "not_ready"}
    return {"status": "ready"}
