#!/usr/bin/env bash
#
# Brings up everything the demo needs, then prints the URL to open.
#
#   scripts/demo-up.sh            # keep the broker's data from last time
#   scripts/demo-up.sh --fresh    # wipe it: new broker identity, new wallets
#
# Three moving parts, each of which has failed silently at least once:
#
#   1. `ngd`, NextGraph's broker, in a Linux container. It does not build on
#      macOS (NEXTGRAPH-ISSUES.md D3), so the binary is the one built once
#      under linux/amd64 in ../nextgraph-rs/target-docker-amd64. `--local`
#      binds loopback only, so a socat forwarder in the same network namespace
#      is what actually exposes it on the host port.
#   2. atomic-server's data-browser dev server, on the branch with the bridge.
#   3. The URL: `?ngbridge=1` turns the mirror on, `?ngbroker=` points wallet
#      creation at our broker rather than nextgraph.eu, which refuses wallets
#      it has not registered (B3). Both persist in localStorage, so the URL
#      only needs its parameters the first time.
set -euo pipefail

# The docker CLI lives wherever the runtime put it, which a non-login shell
# may not have on PATH. OrbStack's and Docker Desktop's locations, then whatever is there.
export PATH="$HOME/.orbstack/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NG_RS="${NG_RS:-$HERE/../nextgraph-rs}"
ATOMIC="${ATOMIC:-$HERE/../atomic-server}"
NGD_BIN="$NG_RS/target-docker-amd64/debug/ngd"
BROKER_PORT=14400
APP_PORT=6750
LOGS="$HERE/.demo"
mkdir -p "$LOGS"

BOOTSTRAP="http://localhost:$BROKER_PORT/.ng_bootstrap"
APP="http://localhost:$APP_PORT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

[ -x "$NGD_BIN" ] || { echo "no broker binary at $NGD_BIN (see NEXTGRAPH-ISSUES.md D3 for how it was built)"; exit 1; }

# -- 1. Docker ---------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  say "Starting Docker…"
  # Whichever runtime this machine has. OrbStack here; Docker Desktop elsewhere.
  if command -v orb >/dev/null 2>&1; then orb start >/dev/null 2>&1 || true; else open -a Docker; fi
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { echo "Docker did not come up"; exit 1; }
fi

# -- 2. Broker ---------------------------------------------------------------
if [ "${1:-}" = "--fresh" ]; then
  say "Wiping broker state ($NG_RS/.ng)"
  docker rm -f ngd ngd-fwd >/dev/null 2>&1 || true
  rm -rf "$NG_RS/.ng"
fi

if ! curl -sf -m 3 "$BOOTSTRAP" >/dev/null 2>&1; then
  say "Starting broker on :$BROKER_PORT"
  docker rm -f ngd ngd-fwd >/dev/null 2>&1 || true
  docker run -d --name ngd --platform linux/amd64 \
    -p "$BROKER_PORT:14401" \
    -v "$NG_RS:/src" -w /src rust:bookworm \
    /src/target-docker-amd64/debug/ngd -vv --save-key --local 14400 --registration-open \
    >/dev/null
  docker run -d --name ngd-fwd --platform linux/amd64 --network container:ngd \
    alpine/socat TCP-LISTEN:14401,fork,reuseaddr TCP:127.0.0.1:14400 >/dev/null
  for _ in $(seq 1 30); do curl -sf -m 3 "$BOOTSTRAP" >/dev/null 2>&1 && break; sleep 2; done
  curl -sf -m 3 "$BOOTSTRAP" >/dev/null || { echo "broker never answered; docker logs ngd"; exit 1; }
fi
say "Broker: $BOOTSTRAP"

# -- 3. App ------------------------------------------------------------------
if ! curl -sf -m 3 -o /dev/null "$APP/"; then
  branch="$(git -C "$ATOMIC" branch --show-current)"
  [ "$branch" = "feat/ng-bridge" ] || { echo "atomic-server is on '$branch', needs feat/ng-bridge"; exit 1; }
  say "Starting data-browser on :$APP_PORT (log: $LOGS/app.log)"
  # Fully detached: no fd of ours reaches vite, so a caller that pipes this
  # script's output is not held open by the dev server's children.
  #
  # The app is pointed at a port nothing listens on. Its dev config aims it at
  # whatever atomic-server a developer has running, and with one up the app
  # quietly uses it for search and presence — which once put an AtomicServer
  # error toast in the middle of a video whose claim is that there is no
  # AtomicServer. The workspace is local and mirrored either way; this only
  # makes the recording show what is actually the case.
  (cd "$ATOMIC/browser/data-browser" && \
   VITE_ATOMIC_SERVER_URL=http://localhost:9 \
   nohup pnpm dev --port "$APP_PORT" >"$LOGS/app.log" 2>&1 </dev/null & \
   echo $! >"$LOGS/app.pid"; disown) 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-
  for _ in $(seq 1 60); do curl -sf -m 3 -o /dev/null "$APP/" && break; sleep 2; done
  curl -sf -m 3 -o /dev/null "$APP/" || { echo "app never answered; see $LOGS/app.log"; exit 1; }
fi
say "App:    $APP"

echo
say "Open:   $APP/?ngbridge=1&ngbroker=$BOOTSTRAP"
echo
echo "Reload test against this stack:"
echo "  NG_BOOTSTRAP_URL=$BOOTSTRAP pnpm -C e2e demo"
