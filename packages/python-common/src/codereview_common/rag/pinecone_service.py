from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import httpx

from codereview_common.rag.embeddings import (
    EmbeddingSettings,
    embed_texts,
    resolve_embedding_settings,
)
from codereview_common.rag.redaction import content_hash, redact_for_embedding

logger = logging.getLogger(__name__)


def pinecone_namespace(org_id: UUID, repo_id: UUID) -> str:
    return f"org:{org_id}:repo:{repo_id}"


def vector_id(org_id: UUID, repo_id: UUID, path: str, chash: str, chunk_index: int) -> str:
    raw = f"{org_id}|{repo_id}|{path}|{chash}|{chunk_index}"
    return content_hash(raw)


class PineconeMemoryService:
    """Pinecone vector memory with OpenAI or Ollama embeddings."""

    def __init__(
        self,
        api_key: str | None,
        index_name: str | None,
        *,
        embedding_provider: str | None = None,
        openai_api_key: str | None = None,
        ollama_base_url: str | None = None,
        embedding_model: str | None = None,
        embedding_dimension: int | None = None,
    ) -> None:
        self.api_key = api_key
        self.index_name = index_name
        self.embedding = resolve_embedding_settings(
            embedding_provider=embedding_provider,
            openai_api_key=openai_api_key,
            ollama_base_url=ollama_base_url,
            embedding_model=embedding_model,
            embedding_dimension=embedding_dimension,
        )
        self._index = None
        if api_key and index_name:
            try:
                from pinecone import Pinecone

                pc = Pinecone(api_key=api_key)
                self._index = pc.Index(index_name)
                if self.embedding:
                    logger.info(
                        "Pinecone memory ready (index=%s, embeddings=%s/%s, dim=%s)",
                        index_name,
                        self.embedding.provider,
                        self.embedding.model,
                        self.embedding.dimension,
                    )
            except Exception as e:
                logger.warning("Pinecone init failed: %s", e)

    @property
    def enabled(self) -> bool:
        return self._index is not None and self.embedding is not None

    async def _embed(self, client: httpx.AsyncClient, texts: list[str]) -> list[list[float]]:
        assert self.embedding is not None
        return await embed_texts(client, self.embedding, texts)

    async def upsert_findings(
        self,
        org_id: UUID,
        repo_id: UUID,
        review_id: str,
        language: str,
        path: str | None,
        findings: list[Any],
        httpx_client: httpx.AsyncClient,
    ) -> int:
        if not findings or not self.enabled:
            return 0
        namespace = pinecone_namespace(org_id, repo_id)
        vectors: list[dict[str, Any]] = []
        texts: list[str] = []
        meta_rows: list[dict[str, Any]] = []
        for i, f in enumerate(findings):
            summary = f"{f.title}: {f.detail}"[:800]
            text = redact_for_embedding(summary)
            texts.append(text)
            meta_rows.append(
                {
                    "org_id": str(org_id),
                    "repo_id": str(repo_id),
                    "review_id": review_id,
                    "language": language,
                    "path": path or "",
                    "severity": str(f.severity),
                    "category": str(f.category),
                    "finding_fingerprint": content_hash(text + (path or "")),
                }
            )
        embeddings = await self._embed(httpx_client, texts)
        for i, emb in enumerate(embeddings):
            vid = vector_id(org_id, repo_id, path or "", meta_rows[i]["finding_fingerprint"], i)
            vectors.append({"id": vid, "values": emb, "metadata": meta_rows[i]})
        self._index.upsert(vectors=vectors, namespace=namespace)
        return len(vectors)

    async def query_similar(
        self,
        org_id: UUID,
        repo_id: UUID,
        query: str,
        top_k: int,
        httpx_client: httpx.AsyncClient,
    ) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        namespace = pinecone_namespace(org_id, repo_id)
        q = redact_for_embedding(query)
        emb = (await self._embed(httpx_client, [q]))[0]
        res = self._index.query(
            vector=emb,
            top_k=top_k,
            namespace=namespace,
            include_metadata=True,
        )
        hits = []
        matches = getattr(res, "matches", None)
        if matches is None and isinstance(res, dict):
            matches = res.get("matches") or []
        matches = matches or []
        for m in matches:
            if isinstance(m, dict):
                hits.append(
                    {
                        "id": m.get("id"),
                        "score": float(m.get("score", 0.0)),
                        "metadata": dict(m.get("metadata") or {}),
                    }
                )
            else:
                md = getattr(m, "metadata", None) or {}
                hits.append(
                    {
                        "id": getattr(m, "id", None),
                        "score": float(getattr(m, "score", 0.0)),
                        "metadata": dict(md),
                    }
                )
        return hits
