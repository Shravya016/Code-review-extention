from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any

import httpx
import jwt


def create_app_jwt(*, app_id: int, private_key_pem: str) -> str:
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 600, "iss": str(app_id)}
    return jwt.encode(payload, private_key_pem, algorithm="RS256")


async def get_installation_token(
    client: httpx.AsyncClient, *, app_id: int, installation_id: int, private_key_pem: str
) -> str:
    token = create_app_jwt(app_id=app_id, private_key_pem=private_key_pem)
    r = await client.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        timeout=30.0,
    )
    r.raise_for_status()
    return str(r.json()["token"])


def verify_webhook_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    digest = signature_header.removeprefix("sha256=")
    mac = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, digest)
