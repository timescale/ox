import type { Readable } from 'node:stream';

export interface ResolvedPromptInput {
  prompt: string | undefined;
  source: 'arg' | 'stdin' | 'none';
}

export async function readPromptFromStdin(
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<string | undefined> {
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

export async function resolvePromptInput(
  prompt: string | undefined,
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<ResolvedPromptInput> {
  const argPrompt = prompt?.trim();
  if (argPrompt) {
    return { prompt: argPrompt, source: 'arg' };
  }

  const stdinPrompt = await readPromptFromStdin(stdin);
  if (stdinPrompt) {
    return { prompt: stdinPrompt, source: 'stdin' };
  }

  return { prompt: undefined, source: 'none' };
}

export function isMultiWordPrompt(prompt: string): boolean {
  return prompt.trim().split(/\s+/).length > 1;
}
