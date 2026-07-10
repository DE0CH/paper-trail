#!/usr/bin/env python3
"""Run PDF Stack Reader as a web app: build if needed, start the local
server, and open the default browser.

For the desktop app with native menus, use the Electron shell instead:
npm run desktop  (or desktop/make_app.py for a double-clickable macOS app).
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("PORT", "8377"))
URL = f"http://127.0.0.1:{PORT}"


def extend_path() -> None:
    """GUI-launched processes get a minimal PATH; make node/npm findable."""
    extra = ["/opt/homebrew/bin", "/usr/local/bin"]
    parts = os.environ.get("PATH", "").split(os.pathsep)
    os.environ["PATH"] = os.pathsep.join(extra + [p for p in parts if p not in extra])


def needs_build() -> bool:
    index = PROJECT / "dist-web" / "index.html"
    server = PROJECT / "build-node" / "node" / "server.js"
    if not index.exists() or not server.exists():
        return True
    built = min(index.stat().st_mtime, server.stat().st_mtime)
    src_files = list((PROJECT / "src").rglob("*"))
    newest_src = max((p.stat().st_mtime for p in src_files if p.is_file()), default=0)
    return newest_src > built


def build() -> None:
    print("Building…")
    subprocess.run(["npm", "run", "build"], cwd=PROJECT, check=True)


def server_running() -> bool:
    try:
        with urllib.request.urlopen(URL, timeout=1):
            return True
    except Exception:
        return False


def main() -> int:
    extend_path()
    if needs_build():
        build()

    proc: subprocess.Popen[bytes] | None = None
    if not server_running():
        proc = subprocess.Popen(
            ["node", str(PROJECT / "build-node" / "node" / "server.js"), str(PORT)],
            cwd=PROJECT,
        )
        for _ in range(50):
            if server_running():
                break
            time.sleep(0.1)

    webbrowser.open(URL)
    if proc is None:
        print(f"Server already running at {URL}")
        return 0
    print(f"Serving at {URL} — press Ctrl-C to stop.")
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.send_signal(signal.SIGTERM)
        proc.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
