from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import redis.asyncio as redis
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from codereview_api.routers import eval_router, health, memory, metrics, reviews, webhooks
from codereview_api.settings import get_settings
from codereview_common.db.session import create_engine, create_session_factory
from codereview_common.rag.pinecone_service import PineconeMemoryService
from codereview_common.review.pipeline import RealtimeReviewPipeline


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.engine = create_engine(settings.database_url)
    app.state.session_factory = create_session_factory(app.state.engine)
    app.state.http = httpx.AsyncClient()
    app.state.redis = redis.from_url(settings.redis_url, decode_responses=True)
    app.state.memory = PineconeMemoryService(
        settings.pinecone_api_key,
        settings.pinecone_index,
        embedding_provider=settings.embedding_provider,
        openai_api_key=settings.openai_api_key,
        ollama_base_url=settings.ollama_base_url,
        embedding_model=settings.embedding_model,
        embedding_dimension=settings.embedding_dimension,
    )
    app.state.pipeline = RealtimeReviewPipeline(
        default_provider=settings.default_llm_provider,
        default_model=settings.default_llm_model,
        openai_key=settings.openai_api_key,
        mistral_key=settings.mistral_api_key,
        ollama_base=settings.ollama_base_url,
        memory=app.state.memory,
    )
    yield
    await app.state.http.aclose()
    r = app.state.redis
    if hasattr(r, "aclose"):
        await r.aclose()
    else:
        await r.close()
    await app.state.engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="CodeReview API", lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(reviews.router, prefix="/v1")
    app.include_router(webhooks.router, prefix="/v1")
    app.include_router(memory.router, prefix="/v1")
    app.include_router(metrics.router, prefix="/v1")
    app.include_router(eval_router.router, prefix="/v1")
    dashboard = Path(__file__).resolve().parents[3] / "dashboard" / "dist"
    if dashboard.is_dir():
        app.mount("/", StaticFiles(directory=dashboard, html=True), name="dashboard")
    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run("codereview_api.main:app", host="0.0.0.0", port=8000, reload=False)
