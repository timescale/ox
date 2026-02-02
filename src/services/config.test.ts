import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type HermesConfig,
  projectConfig,
  readConfig,
  userConfig,
} from './config';

describe('projectConfig', () => {
  const testConfigDir = '.hermes-test';
  const originalCwd = process.cwd();
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = join(originalCwd, testConfigDir);
    await mkdir(testDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('exists', () => {
    test('returns false when config file does not exist', async () => {
      const exists = await projectConfig.exists();
      expect(exists).toBe(false);
    });

    test('returns true when config file exists', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', 'agent: claude\n');

      const exists = await projectConfig.exists();
      expect(exists).toBe(true);
    });
  });

  describe('read', () => {
    test('returns undefined when config file does not exist', async () => {
      const config = await projectConfig.read();
      expect(config).toBeUndefined();
    });

    test('reads valid config with all fields', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write(
        '.hermes/config.yml',
        `
tigerServiceId: svc-123
agent: claude
model: sonnet
`,
      );

      const config = await projectConfig.read();
      expect(config).toEqual({
        tigerServiceId: 'svc-123',
        agent: 'claude',
        model: 'sonnet',
      });
    });

    test('reads config with only agent field', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write(
        '.hermes/config.yml',
        `
agent: opencode
`,
      );

      const config = await projectConfig.read();
      expect(config).toEqual({
        agent: 'opencode',
      });
    });

    test('reads config with null tigerServiceId', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write(
        '.hermes/config.yml',
        `
tigerServiceId: null
agent: claude
`,
      );

      const config = await projectConfig.read();
      expect(config).toEqual({
        tigerServiceId: null,
        agent: 'claude',
      });
    });

    test('returns empty object for empty config file', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', '');

      const config = await projectConfig.read();
      expect(config).toEqual({});
    });

    test('returns empty object for config with only comments', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write(
        '.hermes/config.yml',
        `
# This is a comment
# Another comment
`,
      );

      const config = await projectConfig.read();
      expect(config).toEqual({});
    });
  });

  describe('write', () => {
    test('writes config with all fields', async () => {
      const config: HermesConfig = {
        tigerServiceId: 'svc-456',
        agent: 'opencode',
        model: 'gpt-4',
      };

      await projectConfig.write(config);

      const content = await Bun.file('.hermes/config.yml').text();
      expect(content).toContain('tigerServiceId: svc-456');
      expect(content).toContain('agent: opencode');
      expect(content).toContain('model: gpt-4');
    });

    test('writes config and creates .hermes directory', async () => {
      const config: HermesConfig = {
        agent: 'claude',
      };

      await projectConfig.write(config);

      const fileExists = await Bun.file('.hermes/config.yml').exists();
      expect(fileExists).toBe(true);
    });

    test('writes config with null tigerServiceId', async () => {
      const config: HermesConfig = {
        tigerServiceId: null,
        agent: 'claude',
      };

      await projectConfig.write(config);

      const content = await Bun.file('.hermes/config.yml').text();
      expect(content).toContain('tigerServiceId: null');
    });

    test('overwrites existing config', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', 'agent: opencode\n');

      await projectConfig.write({ agent: 'claude', model: 'sonnet' });

      const config = await projectConfig.read();
      expect(config?.agent).toBe('claude');
      expect(config?.model).toBe('sonnet');
    });

    test('includes header comments', async () => {
      await projectConfig.write({ agent: 'claude' });

      const content = await Bun.file('.hermes/config.yml').text();
      expect(content).toContain('# Hermes project configuration');
      expect(content).toContain('# Generated by');
    });
  });

  describe('readValue', () => {
    test('reads a single value', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', 'agent: claude\nmodel: sonnet\n');

      const agent = await projectConfig.readValue('agent');
      expect(agent).toBe('claude');
    });

    test('returns undefined for missing key', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', 'agent: claude\n');

      const model = await projectConfig.readValue('model');
      expect(model).toBeUndefined();
    });
  });

  describe('writeValue', () => {
    test('writes a single value to existing config', async () => {
      await mkdir('.hermes', { recursive: true });
      await Bun.write('.hermes/config.yml', 'agent: claude\n');

      await projectConfig.writeValue('model', 'sonnet');

      const config = await projectConfig.read();
      expect(config?.agent).toBe('claude');
      expect(config?.model).toBe('sonnet');
    });

    test('writes a single value to new config', async () => {
      await projectConfig.writeValue('agent', 'opencode');

      const config = await projectConfig.read();
      expect(config?.agent).toBe('opencode');
    });
  });

  describe('roundtrip', () => {
    test('config can be written and read back', async () => {
      const original: HermesConfig = {
        tigerServiceId: 'svc-roundtrip',
        agent: 'claude',
        model: 'opus',
      };

      await projectConfig.write(original);
      const readBack = await projectConfig.read();

      expect(readBack).toEqual(original);
    });

    test('config with undefined fields can be written and read back', async () => {
      const original: HermesConfig = {
        agent: 'opencode',
      };

      await projectConfig.write(original);
      const readBack = await projectConfig.read();

      expect(readBack?.agent).toBe('opencode');
      expect(readBack?.tigerServiceId).toBeUndefined();
      expect(readBack?.model).toBeUndefined();
    });
  });
});

describe('userConfig', () => {
  const originalEnv = process.env.HERMES_USER_CONFIG_DIR;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory for user config
    testDir = join(process.cwd(), '.user-config-test');
    await mkdir(testDir, { recursive: true });
    // Override HERMES_USER_CONFIG_DIR to use test directory
    process.env.HERMES_USER_CONFIG_DIR = testDir;
  });

  afterEach(async () => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.HERMES_USER_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.HERMES_USER_CONFIG_DIR;
    }
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('read', () => {
    test('returns undefined when config file does not exist', async () => {
      const config = await userConfig.read();
      expect(config).toBeUndefined();
    });

    test('reads valid user config', async () => {
      const configDir = userConfig.getConfigDir();
      await mkdir(configDir, { recursive: true });
      await Bun.write(join(configDir, 'config.yml'), 'themeName: dracula\n');

      const config = await userConfig.read();
      expect(config).toEqual({
        themeName: 'dracula',
      });
    });
  });

  describe('write', () => {
    test('writes user config with theme', async () => {
      const config: HermesConfig = {
        themeName: 'nord',
      };

      await userConfig.write(config);

      const configDir = userConfig.getConfigDir();
      const content = await Bun.file(join(configDir, 'config.yml')).text();
      expect(content).toContain('themeName: nord');
      expect(content).toContain('# Hermes user preferences');
    });

    test('creates config directory if it does not exist', async () => {
      const config: HermesConfig = {
        themeName: 'gruvbox',
      };

      await userConfig.write(config);

      const configDir = userConfig.getConfigDir();
      const fileExists = await Bun.file(join(configDir, 'config.yml')).exists();
      expect(fileExists).toBe(true);
    });
  });

  describe('readValue/writeValue', () => {
    test('can read and write individual values', async () => {
      await userConfig.writeValue('themeName', 'catppuccin');

      const themeName = await userConfig.readValue('themeName');
      expect(themeName).toBe('catppuccin');
    });
  });

  describe('roundtrip', () => {
    test('user config can be written and read back', async () => {
      const original: HermesConfig = {
        themeName: 'rosepine',
      };

      await userConfig.write(original);
      const readBack = await userConfig.read();

      expect(readBack).toEqual(original);
    });
  });
});

describe('readConfig (merged config)', () => {
  const testProjectDir = '.hermes-merged-test';
  const originalCwd = process.cwd();
  const originalEnv = process.env.HERMES_USER_CONFIG_DIR;
  let projectTestDir: string;
  let userTestDir: string;

  beforeEach(async () => {
    // Set up project config test directory
    projectTestDir = join(originalCwd, testProjectDir);
    await mkdir(projectTestDir, { recursive: true });
    process.chdir(projectTestDir);

    // Set up user config test directory
    userTestDir = join(originalCwd, '.user-config-merged-test');
    await mkdir(userTestDir, { recursive: true });
    process.env.HERMES_USER_CONFIG_DIR = userTestDir;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv !== undefined) {
      process.env.HERMES_USER_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.HERMES_USER_CONFIG_DIR;
    }
    try {
      await rm(projectTestDir, { recursive: true, force: true });
      await rm(userTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('returns empty object when neither config exists', async () => {
    const config = await readConfig();
    expect(config).toEqual({});
  });

  test('returns user config when only user config exists', async () => {
    await userConfig.write({ themeName: 'dracula', agent: 'claude' });

    const config = await readConfig();
    expect(config).toEqual({ themeName: 'dracula', agent: 'claude' });
  });

  test('returns project config when only project config exists', async () => {
    await projectConfig.write({ agent: 'opencode', model: 'gpt-4' });

    const config = await readConfig();
    expect(config).toEqual({ agent: 'opencode', model: 'gpt-4' });
  });

  test('merges user and project config with project taking precedence', async () => {
    // User sets defaults
    await userConfig.write({
      themeName: 'dracula',
      agent: 'claude',
      model: 'sonnet',
    });

    // Project overrides agent but not theme or model
    await projectConfig.write({ agent: 'opencode' });

    const config = await readConfig();
    expect(config).toEqual({
      themeName: 'dracula', // from user
      agent: 'opencode', // overridden by project
      model: 'sonnet', // from user (not overridden)
    });
  });

  test('project config overrides all matching keys', async () => {
    await userConfig.write({
      themeName: 'nord',
      agent: 'claude',
      model: 'opus',
      tigerServiceId: 'user-svc',
    });

    await projectConfig.write({
      agent: 'opencode',
      model: 'gpt-4',
      tigerServiceId: 'project-svc',
    });

    const config = await readConfig();
    expect(config).toEqual({
      themeName: 'nord', // only in user config
      agent: 'opencode', // project override
      model: 'gpt-4', // project override
      tigerServiceId: 'project-svc', // project override
    });
  });

  test('undefined values in project config do not override user config', async () => {
    await userConfig.write({
      themeName: 'gruvbox',
      agent: 'claude',
      model: 'sonnet',
    });

    // Project config only sets agent, model is undefined
    await projectConfig.write({ agent: 'opencode' });

    const config = await readConfig();
    expect(config?.model).toBe('sonnet'); // user value preserved
    expect(config?.agent).toBe('opencode'); // project override
  });

  test('null values in project config override user config', async () => {
    await userConfig.write({
      tigerServiceId: 'user-svc',
      agent: 'claude',
    });

    // Project explicitly sets tigerServiceId to null (no DB fork)
    await projectConfig.write({
      tigerServiceId: null,
      agent: 'opencode',
    });

    const config = await readConfig();
    expect(config?.tigerServiceId).toBeNull(); // project override with null
    expect(config?.agent).toBe('opencode');
  });
});

describe('config stores are independent', () => {
  const testProjectDir = '.hermes-project-test';
  const originalCwd = process.cwd();
  const originalEnv = process.env.HERMES_USER_CONFIG_DIR;
  let projectTestDir: string;
  let userTestDir: string;

  beforeEach(async () => {
    // Set up project config test directory
    projectTestDir = join(originalCwd, testProjectDir);
    await mkdir(projectTestDir, { recursive: true });
    process.chdir(projectTestDir);

    // Set up user config test directory
    userTestDir = join(originalCwd, '.user-config-independence-test');
    await mkdir(userTestDir, { recursive: true });
    process.env.HERMES_USER_CONFIG_DIR = userTestDir;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv !== undefined) {
      process.env.HERMES_USER_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.HERMES_USER_CONFIG_DIR;
    }
    try {
      await rm(projectTestDir, { recursive: true, force: true });
      await rm(userTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('project and user configs are stored separately', async () => {
    // Write to project config
    await projectConfig.write({ agent: 'claude', model: 'sonnet' });

    // Write to user config
    await userConfig.write({ themeName: 'dracula' });

    // Read back and verify they're independent
    const project = await projectConfig.read();
    const user = await userConfig.read();

    expect(project).toEqual({ agent: 'claude', model: 'sonnet' });
    expect(user).toEqual({ themeName: 'dracula' });

    // Verify they're stored in different locations
    expect(projectConfig.getConfigDir()).not.toBe(userConfig.getConfigDir());
  });
});
