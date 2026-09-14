#!/usr/bin/env bash
#
# The demo in NextGraph's own hosted-wallet mode, on this machine.
#
# NextGraph's published web SDK sends an app to nextgraph.net, whose redirect
# page only accepts brokers on the public list, so a local broker cannot be
# used with it. NextGraph's monorepo has a dev mode for exactly this: the same
# SDK built with NG_DEV_LOCAL_BROKER=1 sends the app to a wallet app on
# localhost:1421, which serves its own redirect and auth pages and talks to
# the local broker. This script builds and starts that stack, then the host
# app pointed at that SDK build. See docs/upstream-findings.md 7d.
#
# Prerequisites: scripts/demo-up.sh once (broker up), Rust with wasm-pack,
# and NextGraph's monorepo checked out beside this one (NG_RS).
set -euo pipefail
export PATH="$HOME/.orbstack/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NG_RS="${NG_RS:-$HERE/../nextgraph-rs}"
ATOMIC="${ATOMIC:-$HERE/../atomic-server-ngbridge}"
BROKER_PORT=14400
APP_PORT=6756
LOGS="$HERE/.demo"
mkdir -p "$LOGS"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

curl -sf -m 3 "http://localhost:$BROKER_PORT/.ng_bootstrap" >/dev/null || { echo "broker not up; run scripts/demo-up.sh first"; exit 1; }

# -- 1. NextGraph's SDK, redirect and auth pages, from its own repo ---------
if [ ! -f "$NG_RS/sdk/js/lib-wasm/pkg/lib_wasm_bg.wasm" ]; then
  say "Building lib-wasm (once, a few minutes)"
  (cd "$NG_RS/sdk/js/lib-wasm" && wasm-pack build --dev --target bundler && node prepare-web.js)
fi
if [ ! -d "$NG_RS/sdk/js/web/node_modules" ]; then
  say "Installing NextGraph's JS workspace"
  (cd "$NG_RS" && pnpm install)
fi
if [ ! -f "$NG_RS/app/nextgraph/public_dev/redir.html" ] || [ ! -f "$NG_RS/sdk/js/web/dist/ngweb.js" ]; then
  say "Building redirect, auth and bootstrap pages and the dev web SDK"
  (cd "$NG_RS" && pnpm buildfrontdev)
fi

# -- 2. The wallet app dev server, which serves those pages ----------------
if ! curl -sf -m 3 -o /dev/null "http://localhost:1421/redir.html"; then
  say "Starting NextGraph's wallet app on :1421 (log: $LOGS/ngapp.log)"
  (cd "$NG_RS/app/nextgraph" && nohup pnpm webdev >"$LOGS/ngapp.log" 2>&1 </dev/null &) 
  for _ in $(seq 1 30); do curl -sf -m 3 -o /dev/null "http://localhost:1421/redir.html" && break; sleep 2; done
fi

# -- 3. The host app, pointed at the dev SDK build -------------------------
if ! curl -sf -m 3 -o /dev/null "http://localhost:$APP_PORT/"; then
  branch="$(git -C "$ATOMIC" branch --show-current)"
  [ "$branch" = "ng-bridge" ] || { echo "atomic-server at $ATOMIC is on '$branch', needs ng-bridge"; exit 1; }
  say "Starting data-browser on :$APP_PORT (log: $LOGS/app-hosted.log)"
  (cd "$ATOMIC/browser/data-browser" && \
   NG_WEB_DEV="$NG_RS/sdk/js/web/dist" VITE_ATOMIC_SERVER_URL=http://localhost:9 \
   nohup pnpm dev --port "$APP_PORT" >"$LOGS/app-hosted.log" 2>&1 </dev/null &)
  for _ in $(seq 1 60); do curl -sf -m 3 -o /dev/null "http://localhost:$APP_PORT/" && break; sleep 2; done
fi

# -- 4. Tell the redirect page about the local broker ----------------------
# The wallet app does this itself when a wallet is imported there, by opening
# the bootstrap page in a popup. The redirect page at 1421 has to know the
# broker before it can show a login at all, so it is registered up front.
PEER="$(docker logs ngd 2>&1 | grep -m1 'PeerId of node' | sed 's/.*PeerId of node: //')"
PAYLOAD="$(printf '[{"peer_id":"%s","localhost":%s}]' "$PEER" "$BROKER_PORT" | base64 | tr '+/' '-_' | tr -d '=\n')"

echo
say "1. Register the broker (opens and closes itself):"
echo "   http://localhost:1421/bootstrap.html#/?b=$PAYLOAD&close=1&m=add&ab=http%3A%2F%2Flocalhost%3A1421%2F"
say "2. Open the app and press Continue with NextGraph:"
echo "   http://localhost:$APP_PORT/?ngbridge=1&ngengine=web"
echo "   On the wallet page: Login, Import a Wallet File, password. The app comes back inside it."
