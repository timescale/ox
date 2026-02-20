#!/bin/bash
# Runs biome lint on files after Edit/Write tool calls.
# Feeds lint errors back to Claude so it can fix them.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if no file path
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only lint file types biome supports
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.jsonc|*.css)
    ;;
  *)
    exit 0
    ;;
esac

# Run lint from the project root
cd "$CLAUDE_PROJECT_DIR" || exit 0

OUTPUT=$(./bun run lint --write "$FILE_PATH" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Lint errors in $FILE_PATH:" >&2
  echo "$OUTPUT" >&2
  exit 2
fi

exit 0
