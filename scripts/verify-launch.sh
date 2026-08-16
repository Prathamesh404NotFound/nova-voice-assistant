#!/usr/bin/env bash
# Verify Nova launches and renders in the sandbox (headless X11 via Xvfb).
set -u
cd "$(dirname "$0")/.."

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x820x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

cleanup() {
  kill "$ELECTRON_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

npx electron . > /tmp/nova-launch.log 2>&1 &
ELECTRON_PID=$!

# wait for the window
for i in $(seq 1 30); do
  if xdotool search --name "Nova" 2>/dev/null | head -1 | grep -q .; then
    break
  fi
  sleep 1
done

WIN=$(xdotool search --name "Nova" 2>/dev/null | head -1)
if [ -z "$WIN" ]; then
  echo "FAIL: Nova window did not appear within 30s"
  tail -20 /tmp/nova-launch.log
  exit 1
fi
echo "OK: Nova window found (id $WIN)"

xdotool windowactivate "$WIN" 2>/dev/null || true
sleep 2

# capture a screenshot
mkdir -p /tmp/nova-shots
import -window root /tmp/nova-shots/shot1.png 2>/dev/null || \
  python3 -c "
from PIL import ImageGrab
ImageGrab.grab().save('/tmp/nova-shots/shot1.png')
" 2>/dev/null || echo "screenshot skipped (no grab tool)"

# capture a second shot after a beat (orb animation)
sleep 3
import -window root /tmp/nova-shots/shot2.png 2>/dev/null || true

echo "DONE. Electron log tail:"
tail -8 /tmp/nova-launch.log
echo "Shots saved to /tmp/nova-shots/"
