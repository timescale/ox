#!/bin/bash
# Generate all documentation GIFs from VHS tape files.
# Prerequisites: vhs, ffmpeg, ttyd, and a Chromium-based browser.
#
# Usage:
#   ./docs/tapes/generate.sh           # generate all GIFs
#   ./docs/tapes/generate.sh <name>    # generate a single GIF (e.g., "prompt-screen")

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

mkdir -p "$REPO_ROOT/docs/images"

# ---------------------------------------------------------------------------
# Setup: make `ox` available on PATH and ensure minimal project config exists
# so the TUI launches directly to the prompt screen (skipping the wizard).
# ---------------------------------------------------------------------------

# 1. Create a temporary bin dir with an `ox` wrapper that runs via bun
TAPE_BIN="$(mktemp -d)"
cat > "$TAPE_BIN/ox" <<WRAPPER
#!/bin/bash
exec "$REPO_ROOT/bun" "$REPO_ROOT/index.ts" "\$@"
WRAPPER
chmod +x "$TAPE_BIN/ox"
export PATH="$TAPE_BIN:$PATH"

# 2. Ensure .ox/config.yml exists (config wizard appears when no config is found)
OX_CONFIG="$REPO_ROOT/.ox/config.yml"
CREATED_CONFIG=0
if [ ! -f "$OX_CONFIG" ]; then
  mkdir -p "$REPO_ROOT/.ox"
  cat > "$OX_CONFIG" <<'CFG'
agent: claude
sandboxProvider: docker
themeName: catppuccin
CFG
  CREATED_CONFIG=1
fi

cleanup() {
  rm -rf "$TAPE_BIN"
  if [ "$CREATED_CONFIG" = "1" ]; then
    rm -f "$OX_CONFIG"
    rmdir "$REPO_ROOT/.ox" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Generate GIFs
# ---------------------------------------------------------------------------

run_tape() {
  local tape="$1"
  local name
  name="$(basename "$tape" .tape)"
  echo "Generating $name.gif..."
  (cd "$REPO_ROOT" && vhs "$tape")
  echo "  -> docs/images/$name.gif"
}

if [ $# -gt 0 ]; then
  tape="$SCRIPT_DIR/$1.tape"
  if [ ! -f "$tape" ]; then
    echo "Error: $tape not found" >&2
    exit 1
  fi
  run_tape "$tape"
else
  for tape in "$SCRIPT_DIR"/*.tape; do
    run_tape "$tape"
  done
fi

echo "Done."
