from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingSettings:
    provider: str  # openai | ollama
    model: str
    dimension: int
    openai_api_key: str | None = None
    ollama_base_url: str | None = None


def ollama_native_base(url: str | None) -> str:
    """Chat uses .../v1; Ollama /api/embed lives on the host root."""
    base = (url or "http://127.0.0.1:11434").rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return base


def resolve_embedding_settings(
    *,
    embedding_provider: str | None,
    openai_api_key: str | None,
    ollama_base_url: str | None,
    embedding_model: str | None,
    embedding_dimension: int | None,
) -> EmbeddingSettings | None:
    provider = (embedding_provider or "").strip().lower()
    if not provider:
        if openai_api_key:
            provider = "openai"
        elif ollama_base_url:
            provider = "ollama"
        else:
            return None

    if provider == "openai":
        if not openai_api_key:
            logger.warning("EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is missing")
            return None
        return EmbeddingSettings(
            provider="openai",
            model=embedding_model or "text-embedding-3-small",
            dimension=embedding_dimension or 1536,
            openai_api_key=openai_api_key,
        )

    if provider == "ollama":
        if not ollama_base_url:
            logger.warning("EMBEDDING_PROVIDER=ollama but OLLAMA_BASE_URL is missing")
            return None
        return EmbeddingSettings(
            provider="ollama",
            model=embedding_model or "nomic-embed-text",
            dimension=embedding_dimension or 768,
            ollama_base_url=ollama_base_url,
        )

    logger.warning("Unknown EMBEDDING_PROVIDER=%s", provider)
    return None


async def embed_openai(
    client: httpx.AsyncClient,
    api_key: str,
    texts: list[str],
    model: str = "text-embedding-3-small",
) -> list[list[float]]:
    payload = {"model": model, "input": texts}
    r = await client.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {api_key}"},
        json=payload,
        timeout=60.0,
    )
    r.raise_for_status()
    data = r.json()
    return [d["embedding"] for d in sorted(data["data"], key=lambda x: x["index"])]


async def embed_ollama(
    client: httpx.AsyncClient,
    base_url: str,
    texts: list[str],
    model: str,
) -> list[list[float]]:
    root = ollama_native_base(base_url)
    payload: dict[str, Any] = {"model": model, "input": texts}
    r = await client.post(f"{root}/api/embed", json=payload, timeout=120.0)
    r.raise_for_status()
    data = r.json()
    embeddings = data.get("embeddings")
    if not embeddings:
        raise ValueError(f"Ollama /api/embed returned no embeddings: {data!r}")
    return embeddings


async def embed_texts(
    client: httpx.AsyncClient,
    settings: EmbeddingSettings,
    texts: list[str],
) -> list[list[float]]:
    if settings.provider == "openai":
        return await embed_openai(
            client, settings.openai_api_key or "", texts, model=settings.model
        )
    return await embed_ollama(
        client, settings.ollama_base_url or "", texts, model=settings.model
    )
