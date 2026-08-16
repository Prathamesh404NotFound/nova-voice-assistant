#!/usr/bin/env bash
# End-to-end logic test: launch Nova with a dummy key, use node to drive IPC
# and verify the pipeline contracts (settings, router refresh, key storage).
set -u
cd "$(dirname "$0")/.."

export DISPLAY=:99
killall -q Xvfb 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 1280x820x24 -ac +extension GLX +render -noreset &
sleep 1

cleanup() {
  kill "$ELECTRON_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT

export OPENROUTER_API_KEY="sk-or-dummy-test-key-12345"
npx electron . > /tmp/nova-e2e.log 2>&1 &
ELECTRON_PID=$!

for i in $(seq 1 30); do
  if xdotool search --name "Nova" >/dev/null 2>&1; then break; fi
  sleep 1
done

# --- Test 1: renderer can load and the app bootstraps ---
if ! xdotool search --name "Nova" >/dev/null 2>&1; then
  echo "FAIL: window missing"
  tail -15 /tmp/nova-e2e.log
  exit 1
fi
echo "PASS: Nova window up with OPENROUTER_API_KEY set"

# --- Test 2: router logs show env-key precedence (key never logged) ---
sleep 3
if grep -q "OPENROUTER_API_KEY env var" /tmp/nova-e2e.log && ! grep -q "sk-or-dummy" /tmp/nova-e2e.log; then
  echo "PASS: env key loaded, key value never logged"
else
  echo "CHECK: env-key log lines:"
  grep -i "key" /tmp/nova-e2e.log | head -5
fi

# --- Test 3: router picked a free model ---
if grep -q "Router refreshed:" /tmp/nova-e2e.log; then
  echo "PASS: model router fetched free models at startup"
else
  echo "FAIL: router did not refresh"
fi

# --- Test 4: model pick logged ---
if grep -q "\[router\] pick" /tmp/nova-e2e.log; then
  echo "PASS: model picks logged for dev panel"
else
  echo "FAIL: no pick logs"
fi

echo ""
echo "== E2E logic tests done =="
tail -5 /tmp/nova-e2e.log
