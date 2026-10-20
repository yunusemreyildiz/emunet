#!/bin/bash
# Install/update emunet from this checkout and run it as a background service.
#   scripts/install-local.sh          → LaunchAgent (no Homebrew needed)
#   scripts/install-local.sh --brew   → local Homebrew tap (local/emunet) + brew services
# The --brew path falls back to the LaunchAgent if Homebrew refuses (e.g. outdated Command Line Tools).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$ROOT/emunet.mjs")"
TAP="local/emunet"
APP_DIR="$HOME/Library/Application Support/emunet"
NODE_BIN="$(command -v node || true)"
LINK_DIR="$(brew --prefix 2>/dev/null || echo /usr/local)/bin"

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
    -e "s|@HOMEPAGE@|https://github.com/yunusemreyildiz/emunet|" "$ROOT/Formula/emunet.rb.in" > "$formula_dir/emunet.rb"
  if brew list --formula "$TAP/emunet" >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 brew reinstall "$TAP/emunet"
  else
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "$TAP/emunet"
  fi
  "$(brew --prefix)/bin/emunet" service install
}

install_agent() {
  [[ -n "$NODE_BIN" ]] || { echo "node is required (brew install node)." >&2; exit 1; }
  mkdir -p "$APP_DIR"
  cp "$ROOT/emunet.mjs" "$APP_DIR/emunet.mjs"
  cat > "$APP_DIR/emunet" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$APP_DIR/emunet.mjs" "\$@"
EOF
  chmod +x "$APP_DIR/emunet"
  ln -sf "$APP_DIR/emunet" "$LINK_DIR/emunet"
  "$APP_DIR/emunet" service install
}

if [[ "${1:-}" == "--brew" ]]; then
  install_brew || { echo; echo "Homebrew install failed → installing as a LaunchAgent instead."; install_agent; }
else
  install_agent
fi
emunet status || true
