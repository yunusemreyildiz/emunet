#!/bin/bash
# Render the Homebrew formula for a published GitHub release.
#
#   1. Push this directory as github.com/<owner>/emunet and tag it:  git tag v0.4.0 && git push --tags
#   2. scripts/release.sh <owner> [path/to/homebrew-tap]
#   3. Commit Formula/emunet.rb in github.com/<owner>/homebrew-tap
#
# Users then install with:  brew install <owner>/tap/emunet
set -euo pipefail

OWNER="${1:?usage: scripts/release.sh <github-owner> [tap-dir]}"
TAP_DIR="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$ROOT/emunet.mjs")"
URL="https://github.com/$OWNER/emunet/archive/refs/tags/v$VERSION.tar.gz"

echo "Fetching $URL"
SHA="$(curl -fsSL "$URL" | shasum -a 256 | cut -d' ' -f1)"
OUT="${TAP_DIR:+$TAP_DIR/Formula/emunet.rb}"
OUT="${OUT:-$ROOT/dist/emunet.rb}"
mkdir -p "$(dirname "$OUT")"
sed -e "s|@URL@|$URL|" -e "s|@SHA@|$SHA|" -e "s|@VERSION@|$VERSION|" \
  -e "s|@HOMEPAGE@|https://github.com/$OWNER/emunet|" "$ROOT/Formula/emunet.rb.in" > "$OUT"
echo "Wrote $OUT (v$VERSION, sha256 $SHA)"
