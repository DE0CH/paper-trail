"""Recompute latest.yml after the Windows installer is re-signed.

Code signing rewrites the installer's bytes, so the sha512 and size that
electron-builder recorded at package time no longer match; electron-updater
refuses an update whose hash disagrees with the feed. This walks latest.yml
line by line (the feed is a small, flat, known shape — no YAML library on
the runner) and refreshes sha512/size wherever they describe an .exe that
exists in the dist directory.

Usage: python src/tools/regen_update_feed.py <dist-dir>
"""

import base64
import hashlib
import re
import sys
from pathlib import Path


def digests(path: Path) -> tuple[str, int]:
    h = hashlib.sha512()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode(), path.stat().st_size


def main() -> None:
    dist = Path(sys.argv[1])
    feed = dist / "latest.yml"
    lines = feed.read_text().splitlines(keepends=True)

    # The file an indented sha512/size line describes is the nearest
    # preceding url:/path: value; top-level sha512 follows path:.
    current: Path | None = None
    out: list[str] = []
    changed = 0
    for line in lines:
        m = re.match(r"^(\s*(?:-\s+)?(?:url|path):\s*)(\S+)\s*$", line)
        if m:
            candidate = dist / m.group(2)
            current = candidate if candidate.suffix == ".exe" and candidate.exists() else None
            out.append(line)
            continue
        m = re.match(r"^(\s*)sha512:\s*\S+\s*$", line)
        if m and current:
            sha, _ = digests(current)
            out.append(f"{m.group(1)}sha512: {sha}\n")
            changed += 1
            continue
        m = re.match(r"^(\s*)size:\s*\d+\s*$", line)
        if m and current:
            _, size = digests(current)
            out.append(f"{m.group(1)}size: {size}\n")
            changed += 1
            continue
        out.append(line)

    if changed == 0:
        raise SystemExit("latest.yml: no sha512/size entries matched an existing .exe")
    feed.write_text("".join(out))
    print(f"latest.yml refreshed: {changed} fields updated")


if __name__ == "__main__":
    main()
