// ============================================================================
// Configuration Service - Read/write YAML config files
// ============================================================================

import { join } from 'node:path';
import { YAML } from 'bun';
import envPaths from 'env-paths';

// ============================================================================
// Types
// ============================================================================

export type AgentType = 'claude' | 'opencode';

/**
 * Ox configuration - all keys are valid at both user and project level.
 * User config provides defaults, project config can override any value.
 */
export interface OxConfig {
  // Tiger service ID to use as the default parent for database forks
  // null = explicitly "none" (skip DB fork by default)
  // undefined = not set
  tigerServiceId?: string | null;

  // Default agent to use (claude or opencode)
  agent?: AgentType;

  // Default model to use for the selected agent
  model?: string;

  // UI theme
  themeName?: string;

  /**
   * Override the Docker image used for sandbox containers.
   * When set, this exact image:tag is pulled and used.
   * Fails if the image is not available (no fallback).
   */
  sandboxBaseImage?: string;

  /**
   * Build sandbox image from Dockerfile instead of pulling.
   * - false/undefined (default): pull from GHCR, don't build
   * - true | 'slim': build using embedded slim.Dockerfile
   * - 'full': build using embedded full.Dockerfile
   * - other string: path to custom Dockerfile to build from
   *
   * When set, takes precedence over sandboxBaseImage.
   */
  buildSandboxFromDockerfile?: boolean | 'slim' | 'full' | string;

  /**
   * Relative paths to overlay with isolated Docker volume mounts (mount mode only).
   * These paths get their own anonymous volumes so container-installed dependencies
   * don't conflict with host files. Cleaned up when the session is deleted.
   * Example: ['node_modules', 'download']
   */
  overlayMounts?: string[];

  /**
   * Shell command to run inside the container before starting the agent.
   * Runs after cd into the working directory, in all modes.
   * Example: './bun i'
   */
  initScript?: string;

  /** Sandbox provider: 'docker' (default) or 'cloud' (Deno Cloud) */
  sandboxProvider?: 'docker' | 'cloud';

  /** Default region for cloud sandboxes */
  cloudRegion?: 'ams' | 'ord';

  /**
   * Enable anonymous usage analytics (default: true).
   * Set to false to disable all telemetry.
   * Can also be disabled via environment variables:
   *   DO_NOT_TRACK=1, NO_TELEMETRY=1, OX_ANALYTICS=false
   */
  analytics?: boolean;
}

// ============================================================================
// Config Key Metadata
// ============================================================================

export type ConfigValueType =
  | 'string'
  | 'boolean'
  | 'string|null'
  | 'string[]'
  | 'boolean|string';

/** Type metadata for each config key, used for validation and parsing in CLI */
export const CONFIG_KEYS: Record<keyof OxConfig, ConfigValueType> = {
  tigerServiceId: 'string|null',
  agent: 'string',
  model: 'string',
  themeName: 'string',
  sandboxBaseImage: 'string',
  buildSandboxFromDockerfile: 'boolean|string',
  overlayMounts: 'string[]',
  initScript: 'string',
  sandboxProvider: 'string',
  cloudRegion: 'string',
  analytics: 'boolean',
};

/**
 * Parse a CLI string value into the appropriate type for a config key.
 * Returns { value } on success, { error } on failure.
 */
export function parseConfigValue(
  key: keyof OxConfig,
  raw: string,
): { value: OxConfig[keyof OxConfig] } | { error: string } {
  const type = CONFIG_KEYS[key];
  if (!type) {
    return { error: `Unknown config key: ${key}` };
  }

  switch (type) {
    case 'boolean':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: `Expected 'true' or 'false' for ${key}, got '${raw}'` };

    case 'boolean|string':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { value: raw };

    case 'string|null':
      if (raw === 'null' || raw === 'none') return { value: null };
      return { value: raw };

    case 'string[]':
      // Accept comma-separated values or JSON array syntax
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return { value: parsed as string[] };
        } catch {
          // Fall through to comma-split
        }
      }
      return { value: raw.split(',').map((s) => s.trim()) };

    case 'string':
      return { value: raw };

    default:
      return { value: raw };
  }
}

// ============================================================================
// Config Store Factory
// ============================================================================

interface ConfigStoreOptions {
  /** Function that returns the config directory path */
  getConfigDir: () => string;
  /** Header comment for the YAML file */
  headerComment: string;
}

interface ConfigStore<T extends object> {
  /** Get the config directory path */
  getConfigDir: () => string;
  /** Get the full path to the config file */
  getConfigPath: () => string;
  /** Check if the config file exists */
  exists: () => Promise<boolean>;
  /** Read the entire config file */
  read: () => Promise<T | undefined>;
  /** Read a single config value */
  readValue: <K extends keyof T>(key: K) => Promise<T[K] | undefined>;
  /** Write the entire config file */
  write: (config: T) => Promise<void>;
  /** Write a single config value */
  writeValue: <K extends keyof T>(key: K, value: T[K]) => Promise<void>;
  /** Remove a single config value */
  deleteValue: <K extends keyof T>(key: K) => Promise<void>;
  /** Delete the entire config file */
  deleteFile: () => Promise<void>;
}

const CONFIG_FILENAME = 'config.yml';

function createConfigStore<T extends object>(
  options: ConfigStoreOptions,
): ConfigStore<T> {
  const { getConfigDir, headerComment } = options;
  const configPath = () => join(getConfigDir(), CONFIG_FILENAME);
  const configFile = () => Bun.file(configPath());

  const exists = async (): Promise<boolean> => configFile().exists();

  const read = async (): Promise<T | undefined> => {
    const file = configFile();
    if (!(await file.exists())) {
      return undefined;
    }

    const content = await file.text();
    const parsed = YAML.parse(content);

    // Handle empty file or invalid YAML
    if (!parsed || typeof parsed !== 'object') {
      return {} as T;
    }

    return parsed as T;
  };

  const readValue = async <K extends keyof T>(
    key: K,
  ): Promise<T[K] | undefined> => {
    const config = await read();
    return config?.[key];
  };

  const write = async (config: T): Promise<void> => {
    await configFile().write(
      `${headerComment}---\n${YAML.stringify(config, null, 2)}`,
    );
  };

  const writeValue = async <K extends keyof T>(
    key: K,
    value: T[K],
  ): Promise<void> =>
    write({
      ...((await read()) as T),
      [key]: value,
    });

  const deleteValue = async <K extends keyof T>(key: K): Promise<void> => {
    const current = await read();
    if (!current) return;
    const { [key]: _, ...rest } = current;
    await write(rest as T);
  };

  const deleteFile = async (): Promise<void> => {
    const { unlink } = await import('node:fs/promises');
    try {
      await unlink(configPath());
    } catch {
      // Ignore if file doesn't exist
    }
  };

  return {
    getConfigDir,
    getConfigPath: configPath,
    exists,
    read,
    readValue,
    write,
    writeValue,
    deleteValue,
    deleteFile,
  };
}

// ============================================================================
// Config Store Instances
// ============================================================================

/** Project config directory: .ox/ in the current working directory */
export const projectConfigDir = () => join(process.cwd(), '.ox');

/** User config directory: OS-specific config path (e.g., ~/.config/ox on Linux) */
export const userConfigDir = () =>
  process.env.OX_USER_CONFIG_DIR || envPaths('ox', { suffix: '' }).config;

/** Project-specific configuration stored in .ox/config.yml */
export const projectConfig = createConfigStore<OxConfig>({
  getConfigDir: projectConfigDir,
  headerComment: `# Ox project configuration
# Generated by 'ox config'
# https://github.com/timescale/ox
`,
});

/** User-level preferences stored in OS-specific config directory */
export const userConfig = createConfigStore<OxConfig>({
  getConfigDir: userConfigDir,
  headerComment: `# Ox user preferences
# https://github.com/timescale/ox
`,
});

// ============================================================================
// Merged Config Reader
// ============================================================================

/**
 * Read the effective/merged config.
 *
 * Config values are merged with project config taking precedence over user config.
 * This allows users to set defaults in their user config (e.g., theme, preferred agent)
 * while allowing per-project overrides.
 *
 * @returns The merged config (empty object if neither config file exists)
 */
export async function readConfig(): Promise<OxConfig> {
  const [user, project] = await Promise.all([
    userConfig.read(),
    projectConfig.read(),
  ]);

  return {
    ...user,
    ...project,
  };
}

/**
 * Read a single value from the merged config.
 *
 * @param key The config key to read
 * @returns The value from merged config, or undefined if not set
 */
export async function readConfigValue<K extends keyof OxConfig>(
  key: K,
): Promise<OxConfig[K] | undefined> {
  const config = await readConfig();
  return config[key];
}
