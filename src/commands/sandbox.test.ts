import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ShellError } from '../utils/shell.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const BUN = resolve(PROJECT_ROOT, 'bun');
const CLI = resolve(PROJECT_ROOT, 'index.ts');

async function runOxInDir(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await Bun.$`${BUN} ${CLI} ${args}`.quiet().cwd(cwd);
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch (err) {
    const shellErr = err as ShellError;
    return {
      stdout: shellErr.stdout?.toString() ?? '',
      stderr: shellErr.stderr?.toString() ?? '',
      exitCode: shellErr.exitCode ?? 1,
    };
  }
}

describe('sandbox command', () => {
  const tempRoot = join(PROJECT_ROOT, '.tmp-sandbox-command-test');

  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(join(tempRoot, '.ox'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('sandbox hash --cloud changes when dockerInSandbox is enabled', async () => {
    await Bun.write(
      join(tempRoot, '.ox/config.yml'),
      'dockerInSandbox: false\n',
    );
    const withoutDocker = await runOxInDir(
      tempRoot,
      'sandbox',
      'hash',
      '--cloud',
    );

    await Bun.write(
      join(tempRoot, '.ox/config.yml'),
      'dockerInSandbox: true\n',
    );
    const withDocker = await runOxInDir(tempRoot, 'sandbox', 'hash', '--cloud');

    expect(withoutDocker.exitCode).toBe(0);
    expect(withDocker.exitCode).toBe(0);
    expect(withoutDocker.stdout.trim()).not.toBe(withDocker.stdout.trim());
  });

  test('sandbox hash --agent includes docker layer when dockerInSandbox is enabled', async () => {
    await Bun.write(
      join(tempRoot, '.ox/config.yml'),
      'dockerInSandbox: true\n',
    );
    const result = await runOxInDir(
      tempRoot,
      'sandbox',
      'hash',
      '--agent',
      'claude',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('-dkr-');
    expect(result.stdout.trim()).toContain('-claude-');
  });
});
