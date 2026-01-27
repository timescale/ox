import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { ensureGitignore, formatShellError, type ShellError } from './utils';

describe('formatShellError', () => {
  test('formats error with stderr only', () => {
    const shellError: ShellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('error: something went wrong'),
    };

    const result = formatShellError(shellError);
    expect(result.message).toBe(
      'Command failed (exit code 1)\nstderr: error: something went wrong',
    );
  });

  test('formats error with stdout only', () => {
    const shellError: ShellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 2,
      stdout: Buffer.from('some output'),
      stderr: Buffer.from(''),
    };

    const result = formatShellError(shellError);
    expect(result.message).toBe(
      'Command failed (exit code 2)\nstdout: some output',
    );
  });

  test('formats error with both stdout and stderr', () => {
    const shellError: ShellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 127,
      stdout: Buffer.from('partial output'),
      stderr: Buffer.from('command not found'),
    };

    const result = formatShellError(shellError);
    expect(result.message).toBe(
      'Command failed (exit code 127)\nstderr: command not found\nstdout: partial output',
    );
  });

  test('formats error with no output', () => {
    const shellError: ShellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    };

    const result = formatShellError(shellError);
    expect(result.message).toBe('Command failed (exit code 1)');
  });

  test('handles undefined stdout/stderr gracefully', () => {
    const shellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 1,
      stdout: undefined,
      stderr: undefined,
    } as unknown as ShellError;

    const result = formatShellError(shellError);
    expect(result.message).toBe('Command failed (exit code 1)');
  });

  test('trims whitespace from output', () => {
    const shellError: ShellError = {
      name: 'ShellError',
      message: 'Command failed',
      exitCode: 1,
      stdout: Buffer.from('  output with spaces  \n'),
      stderr: Buffer.from('\n  error with spaces  \n'),
    };

    const result = formatShellError(shellError);
    expect(result.message).toBe(
      'Command failed (exit code 1)\nstderr: error with spaces\nstdout: output with spaces',
    );
  });
});

describe('ensureGitignore', () => {
  const testGitignorePath = '.gitignore';
  let originalContent: string | null = null;

  beforeEach(async () => {
    // Save original .gitignore if it exists
    const file = Bun.file(testGitignorePath);
    if (await file.exists()) {
      originalContent = await file.text();
    }
  });

  afterEach(async () => {
    // Restore original .gitignore or delete if it didn't exist
    if (originalContent !== null) {
      await Bun.write(testGitignorePath, originalContent);
    } else {
      try {
        await unlink(testGitignorePath);
      } catch {
        // File might not exist, that's ok
      }
    }
    originalContent = null;
  });

  test('adds .hermes/ to empty gitignore', async () => {
    await Bun.write(testGitignorePath, '');

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('.hermes/\n');
  });

  test('adds .hermes/ to existing gitignore without it', async () => {
    await Bun.write(testGitignorePath, 'node_modules/\n.env\n');

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('node_modules/\n.env\n.hermes/\n');
  });

  test('does not add .hermes/ if already present with trailing slash', async () => {
    await Bun.write(testGitignorePath, 'node_modules/\n.hermes/\n.env\n');

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('node_modules/\n.hermes/\n.env\n');
  });

  test('does not add .hermes/ if already present without trailing slash', async () => {
    await Bun.write(testGitignorePath, 'node_modules/\n.hermes\n.env\n');

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('node_modules/\n.hermes\n.env\n');
  });

  test('adds newline before .hermes/ when file does not end with newline', async () => {
    await Bun.write(testGitignorePath, 'node_modules/');

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('node_modules/\n.hermes/\n');
  });

  test('creates gitignore if it does not exist', async () => {
    // Ensure file doesn't exist
    try {
      await unlink(testGitignorePath);
    } catch {
      // OK if doesn't exist
    }

    await ensureGitignore();

    const content = await Bun.file(testGitignorePath).text();
    expect(content).toBe('.hermes/\n');
  });
});
