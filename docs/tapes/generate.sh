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
