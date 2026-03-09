#!/bin/bash
# Install OpenCode CLI (as current user)
# Usage: install-opencode.sh [VERSION]
set -e
VERSION=${1:-latest}
mkdir -p ~/.local/share/opencode ~/.local/bin
curl -fsSL https://opencode.ai/install | bash -s -- --version "$VERSION"
ln -sf ~/.opencode/bin/opencode ~/.local/bin/opencode
