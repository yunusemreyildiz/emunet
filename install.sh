#!/bin/bash
# emunet installer (no Homebrew needed).
#
#   curl -fsSL https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --version 0.5.0   install a specific release (default: latest)
#   --uninstall       remove emunet and its background service
#
# What it does: downloads emunet.mjs from the GitHub release into
# ~/Library/Application Support/emunet, links an `emunet` command, and starts the
# background service (a LaunchAgent in your user account). No sudo.
set -euo pipefail

REPO="yunusemreyildiz/emunet"
RAW_BASE="${EMUNET_RAW_BASE:-https://raw.githubusercontent.com/$REPO}"   # override for testing
APP_DIR="$HOME/Library/Application Support/emunet"
VERSION=""
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2#v}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "emunet only supports macOS."

# Where to put the `emunet` command: the first writable directory that is on PATH.
pick_bin_dir() {
  local dir
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in *":$dir:"*) ;; *) continue ;; esac
    if [[ -d "$dir" && -w "$dir" ]]; then echo "$dir"; return; fi
  done
  mkdir -p "$HOME/.local/bin"
  echo "$HOME/.local/bin"
}

if [[ $UNINSTALL -eq 1 ]]; then
  if command -v emunet >/dev/null 2>&1; then
    emunet off || true
    emunet service uninstall || true
  fi
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    [[ -L "$dir/emunet" && "$(readlink "$dir/emunet")" == "$APP_DIR/"* ]] && rm -f "$dir/emunet"
  done
  rm -rf "$APP_DIR"
  say "emunet removed. Settings are kept in ~/.config/emunet (delete it if you like)."
  exit 0
fi

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || die "Node.js 18+ is required. Install it with 'brew install node' or from https://nodejs.org, then re-run."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js 18+ is required (found $("$NODE" -v))."

if [[ -z "$VERSION" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
  [[ -n "$VERSION" ]] || die "could not find the latest release (GitHub API rate limit?). Retry with --version X.Y.Z"
fi

say "Installing emunet $VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$RAW_BASE/v$VERSION/emunet.mjs" -o "$TMP/emunet.mjs" \
  || die "download failed for v$VERSION"
GOT="$("$NODE" "$TMP/emunet.mjs" version 2>/dev/null || true)"
[[ "$GOT" == "$VERSION" ]] || die "downloaded file reports version '$GOT', expected '$VERSION'"

mkdir -p "$APP_DIR"
mv "$TMP/emunet.mjs" "$APP_DIR/emunet.mjs"
cat > "$APP_DIR/emunet" <<EOF
#!/bin/bash
exec "$NODE" "$APP_DIR/emunet.mjs" "\$@"
EOF
chmod +x "$APP_DIR/emunet"

BIN_DIR="$(pick_bin_dir)"
ln -sf "$APP_DIR/emunet" "$BIN_DIR/emunet"
say "Command: $BIN_DIR/emunet"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac

"$APP_DIR/emunet" service install

cat <<'EOF'

Done. When the internet breaks (VPN on/off, proxy tool crashed, emulator offline):
  emunet fix

Recommended if your VPN client breaks macOS DNS (e.g. OpenVPN Connect):
  emunet mac-dns on        # undo: emunet mac-dns off

Uninstall:
  curl -fsSL https://raw.githubusercontent.com/yunusemreyildiz/emunet/main/install.sh | bash -s -- --uninstall
EOF
