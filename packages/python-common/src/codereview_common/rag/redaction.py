from __future__ import annotations

import hashlib
import re

PEM_PATTERN = re.compile(
    r"-----BEGIN [A-Z0-9 -]+-----[\s\S]*?-----END [A-Z0-9 -]+-----", re.MULTILINE
)
API_KEY_PATTERN = re.compile(
    r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[a-z0-9_\-]{16,}['\"]?"
)


def redact_for_embedding(text: str) -> str:
    """Remove likely secrets before sending text to an embedding model."""
    out = PEM_PATTERN.sub("[REDACTED_PEM]", text)
    out = API_KEY_PATTERN.sub(r"\1=[REDACTED]", out)
    return out


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fingerprint_finding(path: str | None, start: int | None, title: str) -> str:
    key = f"{path or ''}:{start or 0}:{title.strip().lower()}"
    return hashlib.sha256(key.encode()).hexdigest()[:32]
