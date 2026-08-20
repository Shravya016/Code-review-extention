from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as redis

logger = logging.getLogger(__name__)

QUEUE_KEY = "codereview:jobs"


async def enqueue_job(r: redis.Redis, job: dict[str, Any]) -> None:
    await r.lpush(QUEUE_KEY, json.dumps(job))


async def dequeue_blocking(r: redis.Redis, timeout: int = 5) -> dict[str, Any] | None:
    item = await r.brpop(QUEUE_KEY, timeout=timeout)
    if not item:
        return None
    _, raw = item
    return json.loads(raw)
