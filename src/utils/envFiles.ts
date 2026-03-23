import { join } from 'node:path';
import type { AgentType } from '../services/config.ts';
import { projectConfigDir, userConfigDir } from '../services/config.ts';
import { log } from '../services/logger.ts';

export type { AgentType };
export type ProviderType = 'docker' | 'cloud';

export interface EnvFileOptions {
  provider: ProviderType;
  agent?: AgentType;
}

function getScopeEnvFilePaths(baseDir: string, opts: EnvFileOptions): string[] {
  const paths = [join(baseDir, '.env')];

  if (opts.agent) {
    paths.push(join(baseDir, '.env.agents'));
  }

  paths.push(join(baseDir, `.env.${opts.provider}`));

  if (opts.agent) {
    paths.push(join(baseDir, `.env.${opts.provider}.agents`));
    paths.push(join(baseDir, `.env.${opts.agent}`));
    paths.push(join(baseDir, `.env.${opts.provider}.${opts.agent}`));
  }

  return paths;
}

export function getEnvFilePaths(opts: EnvFileOptions): string[] {
  return [
    ...getScopeEnvFilePaths(userConfigDir(), opts),
    ...getScopeEnvFilePaths(projectConfigDir(), opts),
  ];
}

export async function getExistingEnvFilePaths(
  opts: EnvFileOptions,
): Promise<string[]> {
  const paths = getEnvFilePaths(opts);
  const existing = await Promise.all(
    paths.map((path) => Bun.file(path).exists()),
  );

  return paths.filter((_path, index) => existing[index]);
}

export function toEnvFileArgs(paths: string[]): string[] {
  return paths.flatMap((p) => ['--env-file', p]);
}

export function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (!key) {
      continue;
    }

    parsed[key] = line.slice(separator + 1).trim();
  }

  return parsed;
}

export async function loadEnvVars(
  opts: EnvFileOptions,
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};
  const paths = await getExistingEnvFilePaths(opts);

  for (const path of paths) {
    const parsed = parseEnvFile(await Bun.file(path).text());
    Object.assign(merged, parsed);
    log.trace({ keys: Object.keys(parsed), path }, 'Loaded env file');
  }

  return merged;
}
