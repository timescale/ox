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
TEMP_BIN="$(mktemp -d)"
trap 'rm -rf "$TEMP_BIN"' EXIT

mkdir -p "$REPO_ROOT/docs/images"

VHS_BIN="${VHS_BIN:-}"
if [ -z "$VHS_BIN" ]; then
  VHS_BIN="$(command -v vhs || true)"
fi
if [ -z "$VHS_BIN" ] && [ -x "/home/ox/go/bin/vhs" ]; then
  VHS_BIN="/home/ox/go/bin/vhs"
fi
if [ -z "$VHS_BIN" ]; then
  echo "Error: could not find vhs on PATH" >&2
  exit 1
fi

# The tapes invoke `ox`, so provide a repo-local wrapper without requiring installation.
cat >"$TEMP_BIN/ox" <<EOF
#!/bin/sh
exec "$REPO_ROOT/./bun" index.ts "\$@"
EOF
chmod +x "$TEMP_BIN/ox"

# Prefer a locally installed browser, but fall back to a Playwright Chromium download if present.
if ! command -v google-chrome >/dev/null 2>&1 &&
  ! command -v google-chrome-stable >/dev/null 2>&1 &&
  ! command -v chromium >/dev/null 2>&1 &&
  ! command -v chromium-browser >/dev/null 2>&1; then
  PLAYWRIGHT_CHROME="$HOME/.cache/ms-playwright/chromium-1208/chrome-linux/chrome"
  if [ -x "$PLAYWRIGHT_CHROME" ]; then
    ln -s "$PLAYWRIGHT_CHROME" "$TEMP_BIN/google-chrome"
  fi
fi

export PATH="$TEMP_BIN:$PATH"
export VHS_NO_SANDBOX="${VHS_NO_SANDBOX:-1}"

run_tape() {
  local tape="$1"
  local name
  name="$(basename "$tape" .tape)"
  echo "Generating $name.gif..."
  (cd "$REPO_ROOT" && "$VHS_BIN" "$tape")
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
