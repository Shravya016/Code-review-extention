from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class GitHubRestClient:
    """Minimal GitHub REST client for PR review automation."""

    def __init__(self, token: str) -> None:
        self.token = token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def get_pull_request_files(
        self, client: httpx.AsyncClient, owner: str, repo: str, pr_number: int
    ) -> list[dict[str, Any]]:
        url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/files"
        r = await client.get(url, headers=self._headers(), timeout=60.0)
        r.raise_for_status()
        return r.json()

    async def create_check_run(
        self,
        client: httpx.AsyncClient,
        owner: str,
        repo: str,
        head_sha: str,
        name: str,
        summary: str,
    ) -> dict[str, Any]:
        url = f"https://api.github.com/repos/{owner}/{repo}/check-runs"
        body = {
            "name": name,
            "head_sha": head_sha,
            "status": "completed",
            "conclusion": "neutral",
            "output": {"title": "Code review", "summary": summary},
        }
        r = await client.post(url, headers=self._headers(), json=body, timeout=60.0)
        r.raise_for_status()
        return r.json()

    async def post_pull_request_review(
        self,
        client: httpx.AsyncClient,
        owner: str,
        repo: str,
        pr_number: int,
        body: str,
        comments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/reviews"
        payload: dict[str, Any] = {"body": body, "event": "COMMENT"}
        if comments:
            payload["comments"] = comments
        r = await client.post(url, headers=self._headers(), json=payload, timeout=120.0)
        if r.status_code >= 400:
            logger.error("GitHub review failed: %s %s", r.status_code, r.text)
        r.raise_for_status()
        return r.json()
