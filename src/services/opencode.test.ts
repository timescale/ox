import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readOpencodeTheme } from './opencode';

describe('readOpencodeTheme', () => {
  let testDir: string;
  let originalXdgState: string | undefined;

  beforeEach(async () => {
    testDir = join(import.meta.dir, '.opencode-theme-test');
    await mkdir(join(testDir, 'opencode'), { recursive: true });
    originalXdgState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = testDir;
  });

  afterEach(async () => {
    if (originalXdgState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = originalXdgState;
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('returns theme from opencode kv.json when valid', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, JSON.stringify({ theme: 'dracula' }));

    const result = await readOpencodeTheme();
    expect(result).toBe('dracula');
  });

  test('returns null when kv.json does not exist', async () => {
    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when kv.json has no theme key', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, JSON.stringify({ someOtherKey: 'value' }));

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when theme is not a valid ox theme name', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, JSON.stringify({ theme: 'nonexistent-theme-xyz' }));

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when kv.json is invalid JSON', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, 'not valid json{{{');

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when theme value is empty string', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, JSON.stringify({ theme: '' }));

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when theme value is not a string', async () => {
    const kvPath = join(testDir, 'opencode', 'kv.json');
    await Bun.write(kvPath, JSON.stringify({ theme: 42 }));

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });

  test('returns null when state directory does not exist', async () => {
    process.env.XDG_STATE_HOME = '/tmp/nonexistent-xdg-state-dir-test';

    const result = await readOpencodeTheme();
    expect(result).toBeNull();
  });
});
