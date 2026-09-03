#!/usr/bin/env bash
# Stops what demo-up.sh started. Broker data stays unless demo-up.sh --fresh.
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.orbstack/bin:/usr/local/bin:$PATH"
docker rm -f ngd ngd-fwd >/dev/null 2>&1 || true
if [ -f "$HERE/.demo/app.pid" ]; then
  pkill -P "$(cat "$HERE/.demo/app.pid")" 2>/dev/null || true
  kill "$(cat "$HERE/.demo/app.pid")" 2>/dev/null || true
  rm -f "$HERE/.demo/app.pid"
fi
pkill -f "vite.*--port 6750" 2>/dev/null || true
echo "demo stack stopped"
