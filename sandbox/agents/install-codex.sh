#!/bin/bash
# Install OpenAI Codex CLI (as current user)
# Downloads the pre-built Rust binary from GitHub Releases.
# Usage: install-codex.sh [VERSION]
set -e
VERSION=${1:-latest}
mkdir -p ~/.codex ~/.local/bin

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  TARGET="x86_64-unknown-linux-musl" ;;
  aarch64) TARGET="aarch64-unknown-linux-musl" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/openai/codex/releases/latest/download/codex-${TARGET}.tar.gz"
else
  URL="https://github.com/openai/codex/releases/download/rust-v${VERSION}/codex-${TARGET}.tar.gz"
fi

curl -fsSL "$URL" | tar -xzf - -C ~/.local/bin codex
chmod +x ~/.local/bin/codex
