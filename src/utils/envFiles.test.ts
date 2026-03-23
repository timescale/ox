import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEnvFilePaths,
  getExistingEnvFilePaths,
  loadEnvVars,
  parseEnvFile,
} from './envFiles';

function withUserConfigDir(userDir: string, fn: () => void) {
  const original = process.env.OX_USER_CONFIG_DIR;
  process.env.OX_USER_CONFIG_DIR = userDir;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.OX_USER_CONFIG_DIR;
    } else {
      process.env.OX_USER_CONFIG_DIR = original;
    }
  }
}

describe('getEnvFilePaths', () => {
  test('returns full user+project hierarchy for provider and agent', () => {
    const userDir = '/tmp/user-config';
    const cwd = process.cwd();
    const projectDir = join(cwd, '.ox');

    withUserConfigDir(userDir, () => {
      const paths = getEnvFilePaths({ provider: 'docker', agent: 'codex' });

      expect(paths).toEqual([
        join(userDir, '.env'),
        join(userDir, '.env.agents'),
        join(userDir, '.env.docker'),
        join(userDir, '.env.docker.agents'),
        join(userDir, '.env.codex'),
        join(userDir, '.env.docker.codex'),
        join(projectDir, '.env'),
        join(projectDir, '.env.agents'),
        join(projectDir, '.env.docker'),
        join(projectDir, '.env.docker.agents'),
        join(projectDir, '.env.codex'),
        join(projectDir, '.env.docker.codex'),
      ]);
    });
  });

  test('includes only non-agent paths when agent is undefined', () => {
    const userDir = '/tmp/user-config';
    const cwd = process.cwd();
    const projectDir = join(cwd, '.ox');

    withUserConfigDir(userDir, () => {
      const paths = getEnvFilePaths({ provider: 'cloud' });

      expect(paths).toEqual([
        join(userDir, '.env'),
        join(userDir, '.env.cloud'),
        join(projectDir, '.env'),
        join(projectDir, '.env.cloud'),
      ]);
    });
  });
});

describe('parseEnvFile', () => {
  test('parses basic key/value pairs and skips comments/empty lines', () => {
    const content = `
API_URL=https://example.com
# comment

PORT=3000
`;

    expect(parseEnvFile(content)).toEqual({
      API_URL: 'https://example.com',
      PORT: '3000',
    });
  });

  test('handles empty values and trims whitespace from keys and values', () => {
    const content = `
FOO = bar
EMPTY=
SPACED =   value with spaces
`;

    expect(parseEnvFile(content)).toEqual({
      FOO: 'bar',
      EMPTY: '',
      SPACED: 'value with spaces',
    });
  });

  test('ignores lines without equals and keeps text after first equals', () => {
    const content = `
NO_EQUALS_LINE
CONNECTION=postgres://u:p@h/db?sslmode=require
TOKEN=abc=def=ghi
`;

    expect(parseEnvFile(content)).toEqual({
      CONNECTION: 'postgres://u:p@h/db?sslmode=require',
      TOKEN: 'abc=def=ghi',
    });
  });

  test('strips matching surrounding quotes from values', () => {
    const content = `
DOUBLE="hello world"
SINGLE='hello world'
MISMATCHED="hello world'
INNER=has "quotes" inside
EMPTY_DOUBLE=""
EMPTY_SINGLE=''
`;

    expect(parseEnvFile(content)).toEqual({
      DOUBLE: 'hello world',
      SINGLE: 'hello world',
      MISMATCHED: `"hello world'`,
      INNER: 'has "quotes" inside',
      EMPTY_DOUBLE: '',
      EMPTY_SINGLE: '',
    });
  });
});

describe('existing files and loadEnvVars', () => {
  test('loads only existing files and merges from least to most specific', async () => {
    const originalCwd = process.cwd();
    const originalUserConfigDir = process.env.OX_USER_CONFIG_DIR;
    const tempRoot = await mkdtemp(join(tmpdir(), 'ox-env-files-test-'));
    const userDir = join(tempRoot, 'user');
    const projectDir = join(tempRoot, 'project');

    try {
      await mkdir(userDir, { recursive: true });
      await mkdir(join(projectDir, '.ox'), { recursive: true });

      process.env.OX_USER_CONFIG_DIR = userDir;
      process.chdir(projectDir);
      const resolvedProjectDir = process.cwd();

      await Bun.write(
        join(userDir, '.env'),
        ['SHARED=user-base', 'BASE=user', 'TO_BE_OVERRIDDEN=user'].join('\n'),
      );
      await Bun.write(
        join(userDir, '.env.docker.codex'),
        ['USER_SPECIFIC=1', 'TO_BE_OVERRIDDEN=user-specific'].join('\n'),
      );
      await Bun.write(
        join(resolvedProjectDir, '.ox', '.env'),
        ['PROJECT_BASE=1', 'TO_BE_OVERRIDDEN=project-base'].join('\n'),
      );
      await Bun.write(
        join(resolvedProjectDir, '.ox', '.env.agents'),
        ['AGENT_SCOPE=project-agents'].join('\n'),
      );
      await Bun.write(
        join(resolvedProjectDir, '.ox', '.env.codex'),
        ['AGENT_SPECIFIC=project-codex'].join('\n'),
      );
      await Bun.write(
        join(resolvedProjectDir, '.ox', '.env.docker.codex'),
        ['TO_BE_OVERRIDDEN=project-specific'].join('\n'),
      );

      const existingPaths = await getExistingEnvFilePaths({
        provider: 'docker',
        agent: 'codex',
      });
      expect(existingPaths).toEqual([
        join(userDir, '.env'),
        join(userDir, '.env.docker.codex'),
        join(resolvedProjectDir, '.ox', '.env'),
        join(resolvedProjectDir, '.ox', '.env.agents'),
        join(resolvedProjectDir, '.ox', '.env.codex'),
        join(resolvedProjectDir, '.ox', '.env.docker.codex'),
      ]);

      const loaded = await loadEnvVars({ provider: 'docker', agent: 'codex' });
      expect(loaded).toEqual({
        SHARED: 'user-base',
        BASE: 'user',
        USER_SPECIFIC: '1',
        PROJECT_BASE: '1',
        AGENT_SCOPE: 'project-agents',
        AGENT_SPECIFIC: 'project-codex',
        TO_BE_OVERRIDDEN: 'project-specific',
      });
    } finally {
      process.chdir(originalCwd);
      if (originalUserConfigDir === undefined) {
        delete process.env.OX_USER_CONFIG_DIR;
      } else {
        process.env.OX_USER_CONFIG_DIR = originalUserConfigDir;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
