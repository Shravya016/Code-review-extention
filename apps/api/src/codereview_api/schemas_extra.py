from __future__ import annotations

from pydantic import BaseModel, Field


class PrEnqueueRequest(BaseModel):
    owner: str
    repo: str
    pr_number: int = Field(ge=1)
    installation_id: int = Field(ge=1)
    head_sha: str | None = None
