from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class FindingCategory(StrEnum):
    BUG = "bug"
    SECURITY = "security"
    QUALITY = "quality"
    PERFORMANCE = "performance"
    MAINTAINABILITY = "maintainability"


class Severity(StrEnum):
    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Finding(BaseModel):
    id: str
    category: FindingCategory
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    title: str
    detail: str
    cwe_id: str | None = None
    owasp: str | None = None
    path: str | None = None
    start_line: int | None = None
    end_line: int | None = None
    code_snippet_hash: str | None = None
    suggested_fix: str | None = None
    references: list[str] = Field(default_factory=list)


class ReviewResult(BaseModel):
    review_id: str
    model: str
    prompt_versions: list[str] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    token_usage: dict[str, Any] | None = None
    latency_ms: int | None = None
    llm_warning: str | None = Field(
        default=None,
        description="Set when the LLM call failed but static analysis findings were returned.",
    )


class RealtimeReviewRequest(BaseModel):
    org_id: UUID | None = None
    repo_id: UUID | None = None
    language: str = "plaintext"
    path: str | None = None
    content: str
    diff: str | None = None
    model: str | None = None
    provider: str | None = Field(
        default=None,
        description="openai | mistral | ollama; defaults to server default",
    )
    enable_memory: bool = False


class MemorySearchRequest(BaseModel):
    org_id: UUID
    repo_id: UUID
    query: str
    top_k: int = 8


class MemorySearchHit(BaseModel):
    id: str
    score: float
    metadata: dict[str, Any]


class MemoryUpsertRequest(BaseModel):
    org_id: UUID
    repo_id: UUID
    review_id: str
    findings: list[Finding]


class MetricsSummary(BaseModel):
    reviews_last_7d: int
    p95_latency_ms: float | None
    avg_findings_per_review: float | None
    by_category: dict[str, int] = Field(default_factory=dict)


class EvalRunRequest(BaseModel):
    dataset: str
    model: str | None = None


class EvalRunRecord(BaseModel):
    id: UUID
    dataset: str
    model: str
    metrics: dict[str, Any]
    created_at: datetime


class EvalRunsResponse(BaseModel):
    runs: list[EvalRunRecord] = Field(default_factory=list)
