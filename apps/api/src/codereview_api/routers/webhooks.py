from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select

from codereview_api.deps import DbSession, get_redis
from codereview_api.settings import get_settings
from codereview_common.db.models import GitHubInstallation, IdempotencyKey, Review
from codereview_common.github.auth import verify_webhook_signature
from codereview_common.queue.redis_queue import enqueue_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/github")
async def github_webhook(
    request: Request,
    session: DbSession,
    x_hub_signature_256: Annotated[str | None, Header(alias="X-Hub-Signature-256")] = None,
    x_github_delivery: Annotated[str | None, Header(alias="X-GitHub-Delivery")] = None,
):
    settings = get_settings()
    secret = settings.github_webhook_secret or ""
    body = await request.body()
    if secret and not verify_webhook_signature(secret, body, x_hub_signature_256):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid signature")

    event = request.headers.get("X-GitHub-Event", "")
    payload = json.loads(body.decode("utf-8"))

    if event == "ping":
        return {"ok": True}

    if event != "pull_request":
        return {"ignored": event}

    action = payload.get("action")
    if action not in ("opened", "synchronize", "reopened"):
        return {"ignored_action": action}

    pr = payload.get("pull_request") or {}
    repo = payload.get("repository") or {}
    installation = payload.get("installation") or {}
    installation_id = installation.get("id")
    if not installation_id:
        raise HTTPException(400, "missing installation")

    delivery = x_github_delivery or ""
    if delivery:
        existing = await session.execute(
            select(IdempotencyKey).where(IdempotencyKey.delivery_id == delivery)
        )
        if existing.scalar_one_or_none():
            return {"duplicate": True}

    inst = await session.execute(
        select(GitHubInstallation).where(
            GitHubInstallation.installation_id == int(installation_id)
        )
    )
    inst_row = inst.scalar_one_or_none()
    org_id: uuid.UUID | None = inst_row.org_id if inst_row else settings.webhook_default_org_id
    if not org_id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Unknown GitHub installation; map it in github_installations or set WEBHOOK_DEFAULT_ORG_ID",
        )

    head = pr.get("head") or {}
    owner_login = (repo.get("owner") or {}).get("login") or ""
    repo_name = repo.get("name") or ""
    pr_number = int(pr.get("number") or 0)
    head_sha = head.get("sha")

    review = Review(
        org_id=org_id,
        repo_id=None,
        source="pr",
        pr_number=pr_number,
        commit_sha=head_sha,
        status="queued",
    )
    session.add(review)
    await session.flush()
    if delivery:
        session.add(IdempotencyKey(delivery_id=delivery, review_id=review.id))
    await session.commit()

    r = get_redis(request)
    await enqueue_job(
        r,
        {
            "type": "pr_review",
            "review_id": str(review.id),
            "org_id": str(org_id),
            "owner": owner_login,
            "repo": repo_name,
            "pr_number": pr_number,
            "installation_id": int(installation_id),
            "head_sha": head_sha,
        },
    )
    return {"review_id": str(review.id), "queued": True}
