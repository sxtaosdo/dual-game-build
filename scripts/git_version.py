#!/usr/bin/env python3
"""Maintain shidai3's globally monotonic fourth version segment."""

from __future__ import annotations

import re
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)\.(\d+)$")
SUBJECT_RE = re.compile(r"^v(\d+\.\d+\.\d+\.(\d+)):\s+.+")
AGENT_RE = re.compile(r"^Agent:\s*[A-Za-z0-9._+-]+(\s*,\s*[A-Za-z0-9._+-]+)*$")
README_RE = re.compile(r"\*\*当前版本：`v(\d+\.\d+\.\d+\.\d+)`\*\*")


def run_git(*args: str, input_text: str | None = None) -> str:
    return subprocess.check_output(
        ["git", *args],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        input=input_text,
        stderr=subprocess.PIPE,
    ).strip()


def parse_version(value: str) -> tuple[int, int, int, int]:
    match = VERSION_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"invalid four-part version: {value!r}")
    return tuple(map(int, match.groups()))  # type: ignore[return-value]


def history_max_w(subjects: list[str]) -> int:
    values = [int(match.group(2)) for subject in subjects if (match := SUBJECT_RE.match(subject))]
    return max(values, default=0)


def next_version(current: str, subjects: list[str]) -> str:
    major, minor, patch, _ = parse_version(current)
    return f"{major}.{minor}.{patch}.{history_max_w(subjects) + 1}"


def read_worktree_version() -> str:
    version_path = ROOT / "VERSION"
    if version_path.exists():
        return version_path.read_text(encoding="utf-8").strip()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    match = README_RE.search(readme)
    if not match:
        raise ValueError("README.md current version is missing")
    return match.group(1)


def read_index(path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f":{path}"],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        stderr=subprocess.PIPE,
    )


def subjects(ref: str = "HEAD") -> list[str]:
    if ref == "HEAD" and subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        return []
    output = run_git("log", "--format=%s", ref)
    return output.splitlines() if output else []


def update_readme_version(readme: str, version: str) -> str:
    updated, count = README_RE.subn(f"**当前版本：`v{version}`**", readme, count=1)
    if count != 1:
        raise ValueError("README.md current version is missing or duplicated")
    return updated


def write_version(version: str) -> None:
    parse_version(version)
    (ROOT / "VERSION").write_text(f"{version}\n", encoding="utf-8")
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    readme_path.write_text(update_readme_version(readme, version), encoding="utf-8")
    sync_build_info(version)


def sync_build_info(version: str) -> None:
    path = ROOT / "build-info.json"
    info = json.loads(path.read_text(encoding="utf-8"))
    info["version"] = version
    path.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    script = ROOT / "assets/shell/buildInfo.ts"
    if script.exists():
        script.write_text("/** Synchronized by the local version hook. */\nexport const PRODUCT_BUILD_VERSION = '" + version + "';\n", encoding="utf-8")


def stage_version_files(version: str) -> None:
    run_git("add", "build-info.json")
    if (ROOT / "assets/shell/buildInfo.ts").exists():
        run_git("add", "assets/shell/buildInfo.ts")
    run_git("add", "VERSION")
    staged_readme = read_index("README.md")
    updated = update_readme_version(staged_readme, version)
    blob = run_git("hash-object", "-w", "--stdin", input_text=updated)
    mode = run_git("ls-files", "-s", "README.md").split()[0]
    run_git("update-index", "--cacheinfo", f"{mode},{blob},README.md")


def check_candidate(version: str, previous_subjects: list[str]) -> None:
    *_, w = parse_version(version)
    expected = history_max_w(previous_subjects) + 1
    if w != expected:
        raise ValueError(f"version W must be {expected}, got {w}; W is global and never resets")


def check_readme(version: str, readme: str) -> None:
    match = README_RE.search(readme)
    if not match or match.group(1) != version:
        raise ValueError("VERSION and README.md current version must match")


def bump() -> None:
    try:
        check_staged()
        print(f"already prepared v{read_index('VERSION').strip()}")
        return
    except (ValueError, subprocess.CalledProcessError):
        pass
    version = next_version(read_worktree_version(), subjects())
    write_version(version)
    stage_version_files(version)
    check_staged()
    print(f"prepared v{version}")


def check_staged() -> None:
    version = read_index("VERSION").strip()
    check_candidate(version, subjects())
    check_readme(version, read_index("README.md"))


def check_agent_line(message: str) -> None:
    first = next((line.strip() for line in message.splitlines()[1:] if line.strip()), "")
    if not AGENT_RE.match(first):
        raise ValueError(
            'commit body must start with "Agent: <agent-name>" '
            "(known: codex, cursor, dsh); optional details may follow"
        )


def check_commit_msg(path: str) -> None:
    message = Path(path).read_text(encoding="utf-8")
    lines = message.splitlines()
    subject = lines[0] if lines else ""
    version = read_index("VERSION").strip()
    match = SUBJECT_RE.match(subject)
    if not match or match.group(1) != version:
        raise ValueError(f"commit subject must start with v{version}: <summary>")
    check_agent_line(message)


def check_head() -> None:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    parents = run_git("rev-list", "--parents", "-n", "1", "HEAD").split()
    previous = subjects(parents[1]) if len(parents) > 1 else []
    check_candidate(version, previous)
    check_readme(version, (ROOT / "README.md").read_text(encoding="utf-8"))
    match = SUBJECT_RE.match(run_git("log", "-1", "--format=%s"))
    if not match or match.group(1) != version:
        raise ValueError(f"HEAD subject must start with v{version}: <summary>")


def install() -> None:
    run_git("config", "core.hooksPath", ".githooks")
    print("installed .githooks")


def main(argv: list[str]) -> None:
    command = argv[1] if len(argv) > 1 else ""
    if command == "next":
        print(next_version(read_worktree_version(), subjects()))
    elif command == "bump":
        bump()
    elif command == "check-staged":
        check_staged()
    elif command == "check-commit-msg" and len(argv) == 3:
        check_commit_msg(argv[2])
    elif command == "check-head":
        check_head()
    elif command == "install":
        install()
    else:
        raise SystemExit("usage: git_version.py next|bump|check-staged|check-commit-msg <path>|check-head|install")


if __name__ == "__main__":
    try:
        main(sys.argv)
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"version guard failed: {error}") from error
