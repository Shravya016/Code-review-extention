from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from urllib import error, request


ZERO_SHA = "0" * 40


def run_git(args: list[str]) -> str:
    p = subprocess.run(
        ["git", *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return p.stdout.strip()


def parse_updates(stdin_data: str) -> list[tuple[str, str, str, str]]:
    updates: list[tuple[str, str, str, str]] = []
    for line in stdin_data.splitlines():
        parts = line.strip().split()
        if len(parts) != 4:
            continue
        updates.append((parts[0], parts[1], parts[2], parts[3]))
    return updates


def commits_for_update(local_sha: str, remote_sha: str) -> list[str]:
    if not local_sha or local_sha == ZERO_SHA:
        return []
    if not remote_sha or remote_sha == ZERO_SHA:
        rev = local_sha
    else:
        rev = f"{remote_sha}..{local_sha}"
    out = run_git(["rev-list", "--no-merges", "--reverse", rev])
    return [x for x in out.splitlines() if x]


def changed_files_for_commits(commits: list[str]) -> list[str]:
    seen: set[str] = set()
    files: list[str] = []
    for c in commits:
        out = run_git(["diff-tree", "--no-commit-id", "--name-only", "-r", c])
        for f in out.splitlines():
            f = f.strip()
            if not f or f in seen:
                continue
            seen.add(f)
            files.append(f)
    return files


def read_text_file(path: Path, max_bytes: int) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    data = path.read_bytes()
    if len(data) > max_bytes:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def post_review(api_url: str, api_key: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        api_url,
        method="POST",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    with request.urlopen(req, timeout=120) as res:
        raw = res.read().decode("utf-8")
        return json.loads(raw or "{}")


def main() -> int:
    api_base = os.environ.get("CODEREVIEW_API_BASE", "http://localhost:8000").rstrip("/")
    api_url = f"{api_base}/v1/reviews/realtime"
    api_key = os.environ.get("CODEREVIEW_API_KEY", "").strip()
    provider = os.environ.get("CODEREVIEW_PROVIDER", "").strip()
    model = os.environ.get("CODEREVIEW_MODEL", "").strip()
    block_levels = {
        x.strip().lower()
        for x in os.environ.get("CODEREVIEW_BLOCK_SEVERITIES", "high,critical").split(",")
        if x.strip()
    }
    max_files = int(os.environ.get("CODEREVIEW_MAX_FILES", "20"))
    max_file_bytes = int(os.environ.get("CODEREVIEW_MAX_FILE_BYTES", "120000"))

    if not api_key:
        print("CodeReview pre-push: CODEREVIEW_API_KEY is not set; allowing push.")
        return 0

    stdin_data = sys.stdin.read()
    updates = parse_updates(stdin_data)
    if not updates:
        print("CodeReview pre-push: no refs on stdin; allowing push.")
        return 0

    commits: list[str] = []
    for _local_ref, local_sha, _remote_ref, remote_sha in updates:
        commits.extend(commits_for_update(local_sha, remote_sha))
    # Keep unique order.
    commits = list(dict.fromkeys(commits))
    if not commits:
        print("CodeReview pre-push: no commits to review; allowing push.")
        return 0

    files = changed_files_for_commits(commits)
    if not files:
        print("CodeReview pre-push: no changed files; allowing push.")
        return 0
    files = files[:max_files]

    repo_root = Path(run_git(["rev-parse", "--show-toplevel"]))
    blocking_findings: list[dict] = []
    reviewed_files = 0

    for rel in files:
        abs_path = repo_root / rel
        text = read_text_file(abs_path, max_file_bytes)
        if text is None:
            continue
        reviewed_files += 1
        payload: dict[str, object] = {
            "language": abs_path.suffix.removeprefix(".") or "plaintext",
            "path": rel,
            "content": text,
            "enable_memory": True,
        }
        if provider:
            payload["provider"] = provider
        if model:
            payload["model"] = model
        try:
            result = post_review(api_url, api_key, payload)
        except error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            print(f"CodeReview pre-push: API error {e.code}: {detail[:800]}")
            return 2
        except Exception as e:  # noqa: BLE001
            print(f"CodeReview pre-push: request failed: {e}")
            return 2

        for f in result.get("findings", []) or []:
            sev = str((f or {}).get("severity", "")).lower()
            if sev in block_levels:
                blocking_findings.append(
                    {
                        "path": str((f or {}).get("path") or rel),
                        "severity": sev,
                        "title": str((f or {}).get("title") or "Finding"),
                        "detail": str((f or {}).get("detail") or ""),
                    }
                )

    out_dir = repo_root / ".codereview"
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "pre-push-report.json"
    report_path.write_text(
        json.dumps(
            {
                "reviewed_files": reviewed_files,
                "checked_commits": commits,
                "blocking_findings": blocking_findings,
                "block_levels": sorted(block_levels),
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    if blocking_findings:
        print("CodeReview pre-push: BLOCKED due to high-severity findings.")
        for i, f in enumerate(blocking_findings[:20], start=1):
            print(f"  {i}. [{f['severity']}] {f['path']} - {f['title']}")
        print(f"Full report: {report_path}")
        return 2

    print(
        f"CodeReview pre-push: passed ({reviewed_files} file(s) reviewed). Report: {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
