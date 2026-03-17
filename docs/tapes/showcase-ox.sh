#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_session_created() {
  local agent_label="$1"
  local session="$2"
  local branch="$3"
  local prompt="$4"

  cat <<EOF
Started interactive session
  Agent:   $agent_label
  Session: $session
  Branch:  $branch
  Prompt:  $prompt

Attach anytime:
  ox session attach $session
EOF
}

if [ "${1:-}" = "session" ] && [ "${2:-}" = "attach" ]; then
  session="${3:-}"
  if [ -z "$session" ]; then
    echo "Usage: ox session attach <session>" >&2
    exit 1
  fi
  exec "$REPO_ROOT/bun" "$SCRIPT_DIR/showcaseSession.ts" "$session"
fi

if [ "${1:-}" = "sessions" ]; then
  cat <<'EOF'
NAME                  AGENT        MODE         STATUS   BRANCH
demo-claude-auth      Claude Code  interactive  running  refactor-auth-middleware
demo-opencode-tests   OpenCode     interactive  running  add-dashboard-test-coverage
demo-codex-validation Codex        interactive  running  tighten-signup-validation
EOF
  exit 0
fi

agent=''
mode=''
prompt=''

while [ $# -gt 0 ]; do
  case "$1" in
    --agent)
      agent="${2:-}"
      shift 2
      ;;
    -M|--agent-mode)
      mode="${2:-}"
      shift 2
      ;;
    *)
      prompt="$1"
      shift
      ;;
  esac
done

if [ "$mode" != "interactive" ]; then
  echo "This showcase only supports -M interactive" >&2
  exit 1
fi

case "$agent" in
  claude)
    print_session_created \
      'Claude Code' \
      'demo-claude-auth' \
      'refactor-auth-middleware' \
      "${prompt:-Refactor the auth middleware into smaller composable steps}"
    ;;
  opencode)
    print_session_created \
      'OpenCode' \
      'demo-opencode-tests' \
      'add-dashboard-test-coverage' \
      "${prompt:-Add integration coverage for the dashboard loading states}"
    ;;
  codex)
    print_session_created \
      'Codex' \
      'demo-codex-validation' \
      'tighten-signup-validation' \
      "${prompt:-Tighten signup validation and preserve inline form errors}"
    ;;
  *)
    echo "Unknown or missing agent: ${agent:-<none>}" >&2
    exit 1
    ;;
esac

