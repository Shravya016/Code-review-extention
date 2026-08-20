from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from codereview_api.auth import AuthContext, require_bearer
from codereview_api.deps import DbSession
from codereview_common.db.models import FindingRow, Review
from codereview_common.schemas import MetricsSummary

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/summary", response_model=MetricsSummary)
async def metrics_summary(
    auth: Annotated[AuthContext, Depends(require_bearer)],
    session: DbSession,
):
    since = datetime.now(timezone.utc) - timedelta(days=7)
    total_reviews = await session.scalar(
        select(func.count())
        .select_from(Review)
        .where(Review.org_id == auth.org_id, Review.created_at >= since)
    )
    total_reviews = int(total_reviews or 0)

    total_findings = await session.scalar(
        select(func.count())
        .select_from(FindingRow)
        .join(Review, FindingRow.review_id == Review.id)
        .where(Review.org_id == auth.org_id, Review.created_at >= since)
    )
    total_findings = int(total_findings or 0)

    avg_findings = (total_findings / total_reviews) if total_reviews else None

    p95_latency = await session.scalar(
        select(func.percentile_cont(0.95).within_group(Review.latency_ms)).where(
            Review.org_id == auth.org_id,
            Review.created_at >= since,
            Review.latency_ms.isnot(None),
        )
    )

    by_cat_rows = await session.execute(
        select(FindingRow.category, func.count())
        .select_from(FindingRow)
        .join(Review, FindingRow.review_id == Review.id)
        .where(Review.org_id == auth.org_id, Review.created_at >= since)
        .group_by(FindingRow.category)
    )
    by_category = {row[0]: int(row[1]) for row in by_cat_rows.all()}

    return MetricsSummary(
        reviews_last_7d=total_reviews,
        p95_latency_ms=float(p95_latency) if p95_latency is not None else None,
        avg_findings_per_review=float(avg_findings) if avg_findings is not None else None,
        by_category=by_category,
    )
