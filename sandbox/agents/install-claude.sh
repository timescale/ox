#!/bin/bash
# Install Claude Code CLI (as current user)
# Usage: install-claude.sh [VERSION]
set -e
VERSION=${1:-latest}
mkdir -p ~/.claude
curl -fsSL https://claude.ai/install.sh | bash -s "$VERSION"
