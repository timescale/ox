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
TMP_DIR="$(mktemp -d)"
VHS_CONFIG_DIR="$TMP_DIR/ox-config"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
if command -v vhs >/dev/null 2>&1; then
  VHS_BIN="$(command -v vhs)"
elif [ -x "$HOME/.local/bin/vhs" ]; then
  VHS_BIN="$HOME/.local/bin/vhs"
else
  echo "Error: vhs not found on PATH or at \$HOME/.local/bin/vhs" >&2
  exit 1
fi

if command -v chromium >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium-browser)"
else
  echo "Error: chromium not found on PATH" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/docs/images"
mkdir -p "$VHS_CONFIG_DIR"

cat >"$TMP_DIR/chromium" <<EOF
#!/bin/sh
exec "$CHROMIUM_BIN" --no-sandbox "\$@"
EOF
chmod +x "$TMP_DIR/chromium"

run_tape() {
  local tape="$1"
  local name
  name="$(basename "$tape" .tape)"
  echo "Generating $name.gif..."
  (
    cd "$REPO_ROOT" &&
      PATH="$TMP_DIR:$REPO_ROOT:$PATH" \
      OX_USER_CONFIG_DIR="$VHS_CONFIG_DIR" \
      "$VHS_BIN" "$tape"
  )
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
