import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  isMultiWordPrompt,
  readPromptFromStdin,
  resolvePromptInput,
} from './stdinPrompt.ts';

function createStdin(
  chunks: string[],
  isTTY: boolean,
): Readable & { isTTY?: boolean } {
  const stdin = Readable.from(chunks) as Readable & { isTTY?: boolean };
  stdin.isTTY = isTTY;
  return stdin;
}

describe('readPromptFromStdin', () => {
  test('returns undefined when stdin is a tty', async () => {
    const result = await readPromptFromStdin(createStdin(['fix bug'], true));
    expect(result).toBeUndefined();
  });

  test('reads and trims redirected stdin', async () => {
    const result = await readPromptFromStdin(
      createStdin(['  fix the bug\n', 'and add tests\n'], false),
    );
    expect(result).toBe('fix the bug\nand add tests');
  });

  test('returns undefined for blank redirected stdin', async () => {
    const result = await readPromptFromStdin(createStdin([' \n', '\t'], false));
    expect(result).toBeUndefined();
  });
});

describe('resolvePromptInput', () => {
  test('prefers the positional prompt over stdin', async () => {
    const result = await resolvePromptInput(
      '  use the arg prompt  ',
      createStdin(['stdin prompt'], false),
    );
    expect(result).toEqual({
      prompt: 'use the arg prompt',
      source: 'arg',
    });
  });

  test('uses stdin when no positional prompt is provided', async () => {
    const result = await resolvePromptInput(
      undefined,
      createStdin(['prompt from stdin'], false),
    );
    expect(result).toEqual({
      prompt: 'prompt from stdin',
      source: 'stdin',
    });
  });

  test('returns none when no prompt source is available', async () => {
    const result = await resolvePromptInput(undefined, createStdin([], true));
    expect(result).toEqual({
      prompt: undefined,
      source: 'none',
    });
  });

  test('falls through to stdin when positional prompt is blank', async () => {
    const result = await resolvePromptInput(
      '   ',
      createStdin(['fallback prompt'], false),
    );
    expect(result).toEqual({
      prompt: 'fallback prompt',
      source: 'stdin',
    });
  });
});

describe('isMultiWordPrompt', () => {
  test('accepts prompts with whitespace-separated words', () => {
    expect(isMultiWordPrompt('fix\nthis bug')).toBe(true);
  });

  test('rejects single-word prompts', () => {
    expect(isMultiWordPrompt('fix')).toBe(false);
  });
});
