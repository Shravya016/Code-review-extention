from __future__ import annotations

import json
import logging
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)


@dataclass
class CompletionRequest:
    model: str
    system: str
    user: str
    temperature: float = 0.2
    max_tokens: int = 4096
    response_format_json: bool = True


class LLMProvider(ABC):
    name: str

    @abstractmethod
    async def complete(self, client: httpx.AsyncClient, req: CompletionRequest) -> str:
        raise NotImplementedError

    @abstractmethod
    async def stream(
        self, client: httpx.AsyncClient, req: CompletionRequest
    ) -> AsyncIterator[str]:
        raise NotImplementedError
        yield  # pragma: no cover


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def complete(self, client: httpx.AsyncClient, req: CompletionRequest) -> str:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        if req.response_format_json:
            body["response_format"] = {"type": "json_object"}
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
            timeout=120.0,
        )
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"]

    async def stream(
        self, client: httpx.AsyncClient, req: CompletionRequest
    ) -> AsyncIterator[str]:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": True,
        }
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
            timeout=120.0,
        ) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line.removeprefix("data: ").strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta") or {}
                    if "content" in delta and delta["content"]:
                        yield delta["content"]
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue


class MistralProvider(LLMProvider):
    name = "mistral"

    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def complete(self, client: httpx.AsyncClient, req: CompletionRequest) -> str:
        body = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "response_format": {"type": "json_object"},
        }
        r = await client.post(
            "https://api.mistral.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
            timeout=120.0,
        )
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"]

    async def stream(
        self, client: httpx.AsyncClient, req: CompletionRequest
    ) -> AsyncIterator[str]:
        body = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": True,
        }
        async with client.stream(
            "POST",
            "https://api.mistral.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=body,
            timeout=120.0,
        ) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line.removeprefix("data: ").strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta") or {}
                    if "content" in delta and delta["content"]:
                        yield delta["content"]
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue


class OllamaOpenAICompatProvider(LLMProvider):
    """OpenAI-compatible endpoint (Ollama, vLLM, etc.)."""

    name = "ollama"

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def complete(self, client: httpx.AsyncClient, req: CompletionRequest) -> str:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        ollama_timeout = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=10.0)
        r = await client.post(
            f"{self.base_url}/chat/completions", json=body, timeout=ollama_timeout
        )
        if r.status_code >= 500:
            # Ollama can fail on large prompts or unsupported max_tokens for some models.
            retry_body = {
                "model": req.model,
                "messages": [
                    {"role": "system", "content": req.system[:4000]},
                    {"role": "user", "content": req.user[:12000]},
                ],
                "temperature": req.temperature,
            }
            r = await client.post(
                f"{self.base_url}/chat/completions",
                json=retry_body,
                timeout=ollama_timeout,
            )
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"]

    async def stream(
        self, client: httpx.AsyncClient, req: CompletionRequest
    ) -> AsyncIterator[str]:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": True,
        }
        async with client.stream(
            "POST",
            f"{self.base_url}/chat/completions",
            json=body,
            timeout=300.0,
        ) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line.removeprefix("data: ").strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta") or {}
                    if "content" in delta and delta["content"]:
                        yield delta["content"]
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue


def get_provider(
    name: str,
    *,
    openai_key: str | None,
    mistral_key: str | None,
    ollama_base: str | None,
) -> LLMProvider:
    n = name.lower()
    if n == "openai":
        if not openai_key:
            raise ValueError("OPENAI_API_KEY not configured")
        return OpenAIProvider(openai_key)
    if n == "mistral":
        if not mistral_key:
            raise ValueError("MISTRAL_API_KEY not configured")
        return MistralProvider(mistral_key)
    if n == "ollama":
        base = ollama_base or "http://127.0.0.1:11434/v1"
        return OllamaOpenAICompatProvider(base)
    raise ValueError(f"Unknown provider: {name}")
