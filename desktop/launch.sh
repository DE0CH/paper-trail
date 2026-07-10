#!/usr/bin/env bash
# Launch PDF Stack Reader as a desktop app: start the local server and open
# a Chromium-family browser in app mode (no browser UI) with a dedicated
# profile, so the window gets its own process and the server can be shut
# down when the window closes. The web app itself is unchanged — this is
# presentation only.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8377}"
URL="http://127.0.0.1:${PORT}"
PROFILE="${HOME}/.pdf-stack-reader/browser-profile"
mkdir -p "$PROFILE"

# GUI-launched apps get a minimal PATH; make sure node is findable.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "PDF Stack Reader" message "Node.js is required but was not found on PATH."' >/dev/null 2>&1 || true
  echo "node not found" >&2
  exit 1
fi

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Start the server unless one is already running on this port.
if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  node "$DIR/server.js" "$PORT" &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    curl -s -o /dev/null --max-time 1 "$URL" && break
    sleep 0.1
  done
fi

BROWSER=""
for c in \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  if [ -x "$c" ]; then BROWSER="$c"; break; fi
done

if [ -n "$BROWSER" ]; then
  # Dedicated user-data-dir forces a separate browser process that lives
  # exactly as long as the app window — closing it ends this script and
  # (via the trap) the server.
  "$BROWSER" \
    --app="$URL" \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    >/dev/null 2>&1
else
  # Fallback: regular browser tab; keep the server alive until Ctrl-C.
  open "$URL"
  echo "Serving at $URL — press Ctrl-C to stop."
  wait ${SERVER_PID:-}
fi
