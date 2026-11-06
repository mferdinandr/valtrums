#!/usr/bin/env python3
"""Check repository-relative Markdown file links without fetching remote URLs."""
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


def check(root: Path) -> list[str]:
    names = subprocess.check_output(
        ["git", "ls-files", "--", "*.md"], cwd=root, text=True
    ).splitlines()
    errors = []
    for name in names:
        path = root / name
        if not path.is_file():
            continue
        fence = None
        for number, line in enumerate(path.read_text().splitlines(), 1):
            marker = re.match(r"^\s*(`{3,}|~{3,})", line)
            if marker:
                if fence is None:
                    fence = marker.group(1)[0]
                elif marker.group(1)[0] == fence:
                    fence = None
                continue
            if fence is not None:
                continue
            for target in re.findall(r"\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)", line):
                target = target.strip("<>")
                parsed = urlsplit(target)
                if parsed.scheme or parsed.netloc or not parsed.path:
                    continue
                relative = unquote(parsed.path)
                destination = root / relative.lstrip("/") if relative.startswith("/") else path.parent / relative
                if not destination.exists():
                    errors.append(f"{name}:{number}: missing linked file {relative}")
    return errors


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    errors = check(root)
    if errors:
        raise SystemExit("\n".join(errors))
    print("Markdown file links passed (remote URLs and section anchors are not checked)")
