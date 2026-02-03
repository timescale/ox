import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
} from './runInDocker';

const HERMES_DIR = join(process.cwd(), '.hermes');
const CLAUDE_CONFIG_DIR = join(HERMES_DIR, '.claude');
const CLAUDE_HOST_CONFIG_DIR = join(homedir(), '.claude');
const CLAUDE_AUTH_FILE_NAME = '.credentials.json';
export const CLAUDE_CONFIG_VOLUME = `${join(CLAUDE_CONFIG_DIR, CLAUDE_AUTH_FILE_NAME)}:/home/hermes/.claude/${CLAUDE_AUTH_FILE_NAME}`;

const checkConfig = async () => {
  await mkdir(CLAUDE_CONFIG_DIR, { recursive: true });

  const hostCreds = file(join(CLAUDE_HOST_CONFIG_DIR, CLAUDE_AUTH_FILE_NAME));
  if (!(await hostCreds.exists())) {
    log.info('Claude credentials not found in host config directory');
    return;
  }
  const localCreds = file(join(CLAUDE_CONFIG_DIR, CLAUDE_AUTH_FILE_NAME));
  if (
    !(await localCreds.exists()) ||
    (await localCreds.json())?.claudeAiOauth?.expiresAt < Date.now()
  ) {
    await localCreds.write(await hostCreds.bytes());
  }
};

export const runClaudeInDocker = async ({
  dockerArgs = ['--rm'],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
}: RunInDockerOptionsBase): Promise<RunInDockerResult> => {
  await checkConfig();

  return runInDocker({
    dockerArgs: ['-v', CLAUDE_CONFIG_VOLUME, ...dockerArgs],
    cmdArgs,
    cmdName: 'claude',
    dockerImage,
    interactive,
    shouldThrow,
  });
};

export const checkClaudeCredentials = async (
  model = 'haiku',
): Promise<boolean> => {
  const proc = await runClaudeInDocker({
    cmdArgs: ['--model', model, '-p', 'just output `true`, and nothing else'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  log.debug({ exitCode, output, model }, 'checkClaudeCredentials');
  return exitCode === 0;
};
