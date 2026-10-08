#!/bin/bash
# Install/update emunet from this checkout and run it as a background service.
#   scripts/install-local.sh          → LaunchAgent (no Homebrew needed)
#   scripts/install-local.sh --brew   → local Homebrew tap (local/emunet) + brew services
# The --brew path falls back to the LaunchAgent if Homebrew refuses (e.g. outdated Command Line Tools).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$ROOT/emunet.mjs")"
TAP="local/emunet"
LABEL="local.emunet"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENT_DIR="$HOME/Library/Application Support/emunet"
LOG="$HOME/Library/Logs/emunet.log"
NODE_BIN="$(command -v node || true)"
LINK_DIR="$(brew --prefix 2>/dev/null || echo /usr/local)/bin"

stop_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
  for _ in $(seq 1 50); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
}

start_agent() {
  for _ in 1 2 3; do
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap "gui/$(id -u)" "$PLIST" # last try, with the error visible
}

install_brew() {
  local dist="$HOME/.cache/emunet" tarball sha formula_dir
  tarball="$dist/emunet-$VERSION.tar.gz"
  mkdir -p "$dist"
  tar -czf "$tarball" -C "$ROOT" emunet.mjs
  sha="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
  brew tap | grep -qx "$TAP" || brew tap-new --no-git "$TAP" >/dev/null
  formula_dir="$(brew --repository "$TAP")/Formula"
  mkdir -p "$formula_dir"
  sed -e "s|@URL@|file://$tarball|" -e "s|@SHA@|$sha|" -e "s|@VERSION@|$VERSION|" \
    -e "s|@HOMEPAGE@|https://github.com/|" "$ROOT/Formula/emunet.rb.in" > "$formula_dir/emunet.rb"
  if brew list --formula "$TAP/emunet" >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew reinstall "$TAP/emunet"
  else
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "$TAP/emunet"
  fi
  stop_agent
  rm -f "$PLIST"
  brew services restart emunet
}

install_agent() {
  if [[ -z "$NODE_BIN" ]]; then
    echo "node is required (brew install node)." >&2
    exit 1
  fi
  mkdir -p "$AGENT_DIR" "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cp "$ROOT/emunet.mjs" "$AGENT_DIR/emunet.mjs"
  cat > "$AGENT_DIR/emunet" <<EOF
#!/bin/bash
export UV_THREADPOOL_SIZE=16
exec "$NODE_BIN" "$AGENT_DIR/emunet.mjs" "\$@"
EOF
  chmod +x "$AGENT_DIR/emunet"
  ln -sf "$AGENT_DIR/emunet" "$LINK_DIR/emunet"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$AGENT_DIR/emunet</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  stop_agent
  start_agent
  echo "LaunchAgent installed: $PLIST (log: $LOG)"
}

if [[ "${1:-}" == "--brew" ]]; then
  install_brew || { echo; echo "Homebrew install failed → installing as a LaunchAgent instead."; install_agent; }
else
  install_agent
fi
sleep 3
emunet status || true
