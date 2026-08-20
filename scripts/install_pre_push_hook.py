from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
from pathlib import Path


def run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Install CodeReview pre-push hook.")
    p.add_argument(
        "--repo-path",
        default=".",
        help="Path to target repository/workspace (default: current directory).",
    )
    p.add_argument(
        "--github-url",
        default="",
        help="Optional GitHub remote URL to configure as origin (bootstraps git init if missing).",
    )
    p.add_argument(
        "--default-branch",
        default="main",
        help="Branch name to set when initializing git (default: main).",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_path).resolve()
    git_dir = repo_root / ".git"

    if not git_dir.exists():
        if not args.github_url.strip():
            raise SystemExit(
                f"{repo_root} is not a git repository. "
                "Provide --github-url to bootstrap git, or run `git init` first."
            )
        run_git(["init"], repo_root)
        run_git(["branch", "-M", args.default_branch], repo_root)
        run_git(["remote", "add", "origin", args.github_url.strip()], repo_root)
        print(f"Initialized git repo at {repo_root} and added origin -> {args.github_url.strip()}")
    elif args.github_url.strip():
        # Update/add origin to user-provided URL.
        try:
            run_git(["remote", "set-url", "origin", args.github_url.strip()], repo_root)
        except subprocess.CalledProcessError:
            run_git(["remote", "add", "origin", args.github_url.strip()], repo_root)
        print(f"Configured origin -> {args.github_url.strip()}")

    src = repo_root / ".githooks" / "pre-push"
    dst = repo_root / ".git" / "hooks" / "pre-push"
    if not src.exists():
        raise SystemExit(f"Missing hook source: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    try:
        mode = os.stat(dst).st_mode
        os.chmod(dst, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    print(f"Installed pre-push hook: {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
