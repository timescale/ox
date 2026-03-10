import type { Readable } from 'node:stream';

export interface ResolvedPromptInput {
  prompt: string | undefined;
  source: 'arg' | 'stdin' | 'none';
}

/**
 * Read prompt text from stdin when it is redirected (pipe or file).
 *
 * When no custom stream is provided we use `Bun.stdin.text()` instead of
 * iterating `process.stdin` with `for await`.  A transitive dependency
 * (`build-strap/src/prompt.js`) performs `import { stdin } from 'process'`
 * at module-evaluation time, which triggers a Bun bug that eagerly drains
 * file-backed stdin before user code can read it.  `Bun.stdin` is not
 * affected by this bug.
 *
 * The optional `stdin` parameter is retained so tests can inject a fake
 * `Readable` stream.
 */
export async function readPromptFromStdin(
  stdin?: Readable & { isTTY?: boolean },
): Promise<string | undefined> {
  if (stdin) {
    if (stdin.isTTY) {
      return undefined;
    }
    let text = '';
    for await (const chunk of stdin) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    }
    const prompt = text.trim();
    return prompt.length > 0 ? prompt : undefined;
  }

  // Default path: use Bun.stdin to avoid the eager-drain bug.
  if (process.stdin.isTTY) {
    return undefined;
  }
  const text = (await Bun.stdin.text()).trim();
  return text.length > 0 ? text : undefined;
}

export async function resolvePromptInput(
  prompt: string | undefined,
  stdin?: Readable & { isTTY?: boolean },
): Promise<ResolvedPromptInput> {
  const trimmed = prompt?.trim();

  // Explicit `-` means "read from stdin"
  if (trimmed === '-') {
    const stdinPrompt = await readPromptFromStdin(stdin);
    if (stdinPrompt) {
      return { prompt: stdinPrompt, source: 'stdin' };
    }
    throw new Error(
      'Expected prompt on stdin (got "-") but stdin is empty or a TTY',
    );
  }

  if (trimmed) {
    return { prompt: trimmed, source: 'arg' };
  }

  // Auto-detect: fall through to stdin if available
  const stdinPrompt = await readPromptFromStdin(stdin);
  if (stdinPrompt) {
    return { prompt: stdinPrompt, source: 'stdin' };
  }

  return { prompt: undefined, source: 'none' };
}

export function isMultiWordPrompt(prompt: string): boolean {
  return /\S\s+\S/.test(prompt);
}
