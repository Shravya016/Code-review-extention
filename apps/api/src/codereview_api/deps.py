from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from codereview_common.review.pipeline import RealtimeReviewPipeline


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    factory = request.app.state.session_factory
    async with factory() as session:
        yield session


def get_pipeline(request: Request) -> RealtimeReviewPipeline:
    return request.app.state.pipeline


def get_redis(request: Request):
    return request.app.state.redis


def get_http(request: Request):
    return request.app.state.http


def get_memory(request: Request):
    return request.app.state.memory


DbSession = Annotated[AsyncSession, Depends(get_db)]
Pipeline = Annotated[RealtimeReviewPipeline, Depends(get_pipeline)]
