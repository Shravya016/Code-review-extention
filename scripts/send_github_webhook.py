from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
import uuid
from urllib import request


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Send a signed GitHub pull_request webhook payload.")
    p.add_argument("--url", default="http://localhost:8000/v1/webhooks/github")
    p.add_argument("--secret", required=True, help="Must match GITHUB_WEBHOOK_SECRET")
    p.add_argument("--owner", required=True, help="GitHub owner/org login")
    p.add_argument("--repo", required=True, help="GitHub repo name")
    p.add_argument("--pr-number", required=True, type=int, help="PR number")
    p.add_argument("--installation-id", required=True, type=int, help="GitHub App installation id")
    p.add_argument("--head-sha", required=True, help="Head commit SHA for PR")
    p.add_argument(
        "--action",
        default="synchronize",
        choices=["opened", "synchronize", "reopened"],
        help="pull_request action",
    )
    p.add_argument("--delivery-id", default=str(uuid.uuid4()))
    return p.parse_args()


def main() -> int:
    args = parse_args()

    payload = {
        "action": args.action,
        "installation": {"id": args.installation_id},
        "repository": {"name": args.repo, "owner": {"login": args.owner}},
        "pull_request": {
            "number": args.pr_number,
            "head": {"sha": args.head_sha},
        },
    }
    body = json.dumps(payload).encode("utf-8")
    digest = hmac.new(args.secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    signature = f"sha256={digest}"

    req = request.Request(
        args.url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": args.delivery_id,
            "X-Hub-Signature-256": signature,
        },
    )

    try:
        with request.urlopen(req, timeout=30) as res:
            raw = res.read().decode("utf-8")
            print(f"status={res.status}")
            print(raw)
            return 0
    except Exception as exc:  # noqa: BLE001 - CLI script
        print(f"failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
