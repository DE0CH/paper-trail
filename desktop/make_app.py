#!/usr/bin/env python3
"""Generate a double-clickable macOS app bundle that runs the Electron
desktop shell. The bundle embeds the absolute path of this project, so
re-run this script if you move the project folder.
"""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
APP = PROJECT / "dist" / "PDF Stack Reader.app"

INFO_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PDF Stack Reader</string>
  <key>CFBundleDisplayName</key><string>PDF Stack Reader</string>
  <key>CFBundleIdentifier</key><string>local.pdf-stack-reader</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>PDFStackReader</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""

LAUNCHER = f"""#!/usr/bin/env python3
import os
import subprocess
import sys

PROJECT = {str(PROJECT)!r}
os.environ["PATH"] = os.pathsep.join(
    ["/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")]
)
main_js = os.path.join(PROJECT, "build-node", "desktop", "main.js")
if not os.path.exists(main_js) or not os.path.exists(
    os.path.join(PROJECT, "dist-web", "index.html")
):
    subprocess.run(["npm", "run", "build"], cwd=PROJECT, check=True)
electron = os.path.join(PROJECT, "node_modules", ".bin", "electron")
sys.exit(subprocess.run([electron, main_js], cwd=PROJECT).returncode)
"""


def main() -> int:
    macos = APP / "Contents" / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    (APP / "Contents" / "Info.plist").write_text(INFO_PLIST)
    launcher = macos / "PDFStackReader"
    launcher.write_text(LAUNCHER)
    launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"Created: {APP}")
    print("Move or symlink it into /Applications if you like.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
