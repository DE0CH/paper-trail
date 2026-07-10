#!/usr/bin/env bash
# Generate a double-clickable macOS app bundle that runs desktop/launch.sh.
# The bundle embeds the absolute path of this project, so re-run this script
# if you move the project folder.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$DIR/dist/PDF Stack Reader.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
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
PLIST

cat > "$APP/Contents/MacOS/PDFStackReader" <<LAUNCHER
#!/usr/bin/env bash
exec "$DIR/desktop/launch.sh"
LAUNCHER
chmod +x "$APP/Contents/MacOS/PDFStackReader"

echo "Created: $APP"
echo "Move or symlink it into /Applications if you like."
