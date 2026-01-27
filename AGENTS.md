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

# Linting and formatting (auto-fix) - RUN AFTER EVERY EDIT
./bun run lint --write

# Build standalone binary
./bun run build

# Run tests
./bun test

# Run a single test file
./bun test src/path/to/file.test.ts

# Run tests matching a pattern
./bun test --test-name-pattern "pattern"

# Run the CLI directly
./bun index.ts <command>
```

**Important**: After making code changes, always run:
1. `./bun run lint --write` - Fix formatting/linting issues
2. `./bun run typecheck` - Ensure no type errors
3. `./bun test` - Ensure all tests pass

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
<text fg="#888888" />              // Prefer this
<text style={{ fg: '#888888' }} /> // Avoid this
```

Correct existing usages of `style` when editing components.

## CLI Framework

Uses `commander` for argument parsing. Commands are in `src/commands/`.
