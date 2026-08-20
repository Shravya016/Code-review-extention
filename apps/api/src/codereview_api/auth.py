from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

from fastapi import Header, HTTPException, status


@dataclass
class AuthContext:
    org_id: uuid.UUID


def _parse_api_keys() -> dict[str, uuid.UUID]:
    raw = os.environ.get("API_KEYS", "")
    out: dict[str, uuid.UUID] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        key, org = part.split(":", 1)
        out[key.strip()] = uuid.UUID(org.strip())
    return out


_API_KEY_MAP = _parse_api_keys()


def require_bearer(authorization: str | None = Header(default=None)) -> AuthContext:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    org = _API_KEY_MAP.get(token)
    if not org:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")
    return AuthContext(org_id=org)

