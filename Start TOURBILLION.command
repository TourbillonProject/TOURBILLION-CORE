#!/bin/bash
# TOURBILLION CORE — one-click launcher for macOS.
# Double-click in Finder. The first run installs a private copy of Node.js
# (inside this folder, no admin password), installs and builds the app, then
# opens it in your browser. Later runs start in a few seconds.
# Close this window (or press Control-C) to stop TOURBILLION.

set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
NODE_DIR="$APP_DIR/.runtime/node"
DATA_DIR="$HOME/Library/Application Support/TOURBILLION CORE"
PORT="${TC_PORT:-8787}"
URL="http://localhost:$PORT"
NEED_MAJOR=22
NEED_MINOR=13

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; echo; read -r -p "Press Return to close." _; exit 1; }

clear
printf '\033[1;36m  T O U R B I L L I O N   C O R E\033[0m\n'

# 1. Already running? Just open it.
if curl -fs "$URL/api/health" >/dev/null 2>&1; then
  say "TOURBILLION is already running — opening $URL"
  open "$URL"
  exit 0
fi

# 2. Node.js 22.13+ (use the system one if new enough, otherwise a private copy).
node_ok() {
  local v; v="$("$1" -v 2>/dev/null | sed 's/^v//')" || return 1
  local major="${v%%.*}" rest="${v#*.}"; local minor="${rest%%.*}"
  [[ "$major" -gt "$NEED_MAJOR" || ( "$major" -eq "$NEED_MAJOR" && "$minor" -ge "$NEED_MINOR" ) ]]
}
if [[ -x "$NODE_DIR/bin/node" ]] && node_ok "$NODE_DIR/bin/node"; then
  export PATH="$NODE_DIR/bin:$PATH"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  :
else
  say "Installing Node.js (one time, about 50 MB)…"
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  BASE="https://nodejs.org/dist/latest-v${NEED_MAJOR}.x"
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "Could not reach nodejs.org. Check the internet connection."
  FILE="$(grep -o "node-v[0-9.]*-darwin-$ARCH.tar.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [[ -n "$FILE" ]] || fail "Could not find a Node.js download for this Mac."
  curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE" || fail "Node.js download failed."
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || fail "Node.js download did not match its checksum."
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$FILE" -C "$NODE_DIR" --strip-components 1
  rm -rf "$TMP"
  export PATH="$NODE_DIR/bin:$PATH"
fi
echo "  Node.js $(node -v)"

# 3. Dependencies and build (only when something changed).
STAMP="$APP_DIR/.runtime/built.stamp"
mkdir -p "$APP_DIR/.runtime"
if [[ ! -d node_modules || package-lock.json -nt "$STAMP" ]]; then
  say "Installing components (first run takes a few minutes)…"
  npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error || fail "Installing components failed."
  rm -f "$STAMP"
fi
if [[ ! -f server/dist/server.js || ! -f "$STAMP" ]] || [[ -n "$(find shared/src server/src web/src web/index.html web/public bridge/src -newer "$STAMP" -print -quit 2>/dev/null)" ]]; then
  say "Building TOURBILLION…"
  npm run build --silent || fail "The build failed. Scroll up for details."
  touch "$STAMP"
fi

# 4. Use Google Chrome for the live remote browser if it is installed.
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  [[ -x "$c" && -z "${TC_BROWSER_EXECUTABLE:-}" ]] && export TC_BROWSER_EXECUTABLE="$c"
done

# 5. Start. Data (database, keys, memories) lives outside this folder, so updating the app keeps it.
mkdir -p "$DATA_DIR"
export TC_DATA_DIR="$DATA_DIR" TC_PORT="$PORT" NODE_ENV=production
[[ -f .env ]] && set -a && . ./.env && set +a

say "Starting TOURBILLION CORE on $URL"
node server/dist/server.js &
SERVER=$!
trap 'echo; echo "Stopping TOURBILLION…"; kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null; exit 0' INT TERM HUP EXIT

for _ in $(seq 1 60); do
  curl -fs "$URL/api/health" >/dev/null 2>&1 && break
  kill -0 $SERVER 2>/dev/null || fail "TOURBILLION stopped while starting. Scroll up for details."
  sleep 0.5
done

if [[ -f "$DATA_DIR/setup-code.txt" ]]; then
  CODE="$(tr -d '[:space:]' < "$DATA_DIR/setup-code.txt")"
  printf '%s' "$CODE" | pbcopy
  printf '\n\033[1;33m  FIRST-TIME SETUP CODE: %s  (copied — just paste it)\033[0m\n' "$CODE"
fi
IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
printf '\n  Open on this Mac:   %s\n' "$URL"
[[ -n "$IP" ]] && printf '  Open on your iPad:  http://%s:%s  (same Wi-Fi)\n' "$IP" "$PORT"
printf '\n  Keep this window open. Close it to stop TOURBILLION.\n'
open "$URL"
wait $SERVER
