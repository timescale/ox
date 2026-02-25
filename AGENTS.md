# Hermes Agent Guidelines

This file provides guidance for AI coding agents working in this repository.

## Build, Lint, and Test Commands

Always use `./bun` wrapper script (auto-installs pinned Bun version):

```bash
# Install dependencies
./bun install

# Type checking
./bun run typecheck

# Linting and formatting (check only)
./bun run lint

# Linting and formatting (auto-fix)
./bun run lint --write

# Run tests
./bun test

# Run a single test file
./bun test src/path/to/file.test.ts

# Run tests matching a pattern
./bun test --test-name-pattern "pattern"

# Shorthand for all checks (typecheck, lint auto-fix, tests)
./bun run check

# Build standalone binary
./bun run build

# Run the CLI directly
./bun index.ts <command>

# Run the pilotty CLI for terminal automation testing
./bun run pilotty <args>
```

**Important**: After making code changes, always run `./bun run check`.

## Code Style

### Formatting (Biome)

- Indent with **spaces** (not tabs)
- Use **single quotes** for strings
- Biome handles formatting and linting - don't use ESLint/Prettier

### Imports

```typescript
// Node.js built-ins (always use node: prefix)
import { mkdir } from 'node:fs/promises';

// Bun built-ins
import { YAML } from 'bun';

// Text file imports (Bun feature)
import DOCKERFILE from '../../sandbox/Dockerfile' with { type: 'text' };
```

Use `type` keyword for type-only imports: `import type { X } from './module.ts'`

### TypeScript

- Strict mode enabled (`strict: true`)
- `noUncheckedIndexedAccess` enabled - handle potential undefined from array/object access
- Use `interface` for object shapes, `type` for unions/aliases
- JSX uses `@opentui/react` (terminal UI, not browser DOM)

### Naming Conventions

- **Files**: `camelCase.ts` for modules, `PascalCase.tsx` for React components
- **Functions/variables**: `camelCase`
- **React components**: `PascalCase`
- **Types/interfaces**: `PascalCase`
- **Constants**: `SCREAMING_SNAKE_CASE`
- **Props interfaces**: suffix with `Props` (e.g., `SelectorProps`)

```typescript
const CONFIG_DIR = '.hermes';                                    // Constants: SCREAMING_SNAKE_CASE
export interface HermesConfig { agent: AgentType; }              // Interfaces: PascalCase
export type AgentType = 'claude' | 'opencode';                   // Types: PascalCase
async function generateBranchName(prompt: string) { }            // Functions: camelCase
function Selector({ title, onSelect }: SelectorProps) { }        // Components: PascalCase
```

### Error Handling

Use the `ShellError` interface for shell command errors:

```typescript
import { formatShellError, type ShellError } from '../utils.ts';

// Pattern 1: Format shell errors for user display
try {
  const result = await Bun.$`git remote get-url origin`.quiet();
} catch (err) {
  throw formatShellError(err as ShellError);
}

// Pattern 2: Silent failure for optional operations
async function isDockerInstalled(): Promise<boolean> {
  try {
    await Bun.$`which docker`.quiet();
    return true;
  } catch {
    return false;
  }
}
```

## Bun-Specific Patterns

Use Bun APIs instead of Node.js equivalents:

```typescript
// Shell commands (use .quiet() to suppress output)
const result = await Bun.$`git status`.quiet();
const output = result.stdout.toString();

// File operations
const file = Bun.file(path);
const exists = await file.exists();
const content = await file.text();
await Bun.write(path, content);

// YAML parsing
import { YAML } from 'bun';
const data = YAML.parse(content);
const str = YAML.stringify(data);

// Process spawning with TTY
const proc = Bun.spawn(['docker', 'run', '-it', image], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
await proc.exited;
```

## Testing

Use Bun's built-in test runner. Tests are colocated with source files using `.test.ts` suffix.

```typescript
import { test, expect, describe } from 'bun:test';

describe('featureName', () => {
  test('should do something', () => {
    expect(result).toBe(expected);
  });
});
```

### Test Guidelines

- **Run tests after changes**: Always run `./bun test` after modifying code
- **Colocate tests**: Place `foo.test.ts` next to `foo.ts`
- **Export for testability**: If a function needs testing, export it
- **Use descriptive names**: Test names should describe expected behavior
- **Test edge cases**: Include tests for error conditions and boundary cases

## Project Structure

```
hermes/
├── index.ts                 # CLI entry point
├── src/
│   ├── index.ts            # CLI setup with commander
│   ├── utils.ts            # Shared utilities
│   ├── commands/           # CLI command implementations
│   ├── components/         # React TUI components (@opentui/react)
│   ├── services/           # Business logic
│   └── types/              # Type declarations
├── sandbox/
│   └── Dockerfile          # Agent container image
└── .hermes/                # Local config (gitignored)
```

## TUI Components

This project uses `@opentui/react` for terminal UIs (not browser React):

```tsx
<box border="single" padding={1}>
  <text bold color="green">Title</text>
</box>

// Keyboard handling
const { registerKeys } = useKeyboard();
registerKeys(['escape'], () => onCancel());
```

Always prefer to use the named props over the `style` prop for better readability.

```tsx
<text fg={theme.textMuted} />            // Prefer this
<text style={{ fg: theme.textMuted }} /> // Avoid this
```

Correct existing usages of `style` when editing components.

## Patched Dependencies

This project uses `bun patch` to maintain patches against npm dependencies. Patch files live in `patches/` and are auto-applied by `bun install`.

**IMPORTANT**: Never edit patch files (`patches/*.patch`) directly. The hunk headers contain line counts that must match exactly, and manual edits will corrupt them. Always use the `bun patch` workflow:

```bash
# 1. Tell bun you want to edit a package (restores original source to node_modules)
./bun patch <package>@<version>

# 2. Edit the source files directly in node_modules/<package>/
#    Make your changes to the actual JS/TS files.

# 3. Commit the patch (regenerates the .patch file and reinstalls)
./bun patch --commit 'node_modules/<package>'
```

### Example: Modifying the `@deno/sandbox` transport patch

```bash
# Start patching
./bun patch @deno/sandbox@0.12.0

# Edit the source file directly
# (e.g., node_modules/@deno/sandbox/esm/transport.js)

# Commit when done
./bun patch --commit 'node_modules/@deno/sandbox'
```

### Troubleshooting

- If `bun patch --commit` fails with a `gitattributes` symlink error, temporarily move `~/.gitattributes` aside, run the commit, then restore it.
- After committing, always verify with `./bun install` followed by checking that your changes are present in the installed file.

## CLI Framework

Uses `commander` for argument parsing. Commands are in `src/commands/`.

## TUI Testing with Pilotty

Pilotty is a terminal automation tool for testing TUI applications. Use it to spawn the app in a managed PTY session and interact with it programmatically.

### Basic Commands

```bash
# Spawn hermes in a pilotty session
./bun run pilotty spawn --name hermes bash -c "cd $PWD && ./bun index.ts"

# Get a text snapshot of the screen
./bun run pilotty snapshot -s hermes

# Type text at current cursor position
./bun run pilotty type -s hermes "some text"

# Send keyboard keys (enter, escape, up, down, tab, etc.)
./bun run pilotty key -s hermes enter
./bun run pilotty key -s hermes escape
./bun run pilotty key -s hermes down

# Kill the session when done
./bun run pilotty kill -s hermes
```

### Testing Workflow

1. **Spawn the app**: Start with `pilotty spawn` and give the session a name
2. **Wait for startup**: Add `sleep 2` after spawn to let the app initialize
3. **Interact**: Use `type` for text input and `key` for special keys
4. **Verify**: Use `snapshot` to check the screen state
5. **Cleanup**: Kill the session when done

### Example Test Sequence

```bash
# Start the app
./bun run pilotty spawn --name hermes bash -c "cd $PWD && ./bun index.ts"

# Wait for startup, type "/", wait, then snapshot
sleep 2 && ./bun run pilotty type -s hermes "/" && sleep 0.5 && ./bun run pilotty snapshot -s hermes

# Navigate with arrow keys
./bun run pilotty key -s hermes down

# Select with enter
./bun run pilotty key -s hermes enter

# Close modal with escape
./bun run pilotty key -s hermes escape

# Cleanup
./bun run pilotty kill -s hermes
```

### Snapshot Output

The snapshot returns JSON with:

- `text`: The full screen content as a string (rows separated by newlines)
- `cursor`: Current cursor position `{row, col, visible}`
- `size`: Terminal dimensions `{cols, rows}`
- `elements`: Detected UI elements (buttons, inputs, etc.)

**Note**: Colors are not visible in text snapshots. To verify color/styling, test the logic in code or visually inspect the running app.

### Tips

- Chain commands with `&&` and add `sleep` between actions for reliability
- The snapshot text shows exactly what's rendered - useful for verifying layout
- Use `--name` consistently to reference the same session
- Always kill sessions when done to avoid orphaned processes
