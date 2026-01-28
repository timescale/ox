import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import { HASHED_SANDBOX_DOCKER_IMAGE } from './docker';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
} from './runInDocker';

const HERMES_DIR = join(process.cwd(), '.hermes');
const OPENCODE_CONFIG_DIR = join(HERMES_DIR, '.local', 'share', 'opencode');
const OPENCODE_HOST_CONFIG_DIR = join(homedir(), '.local', 'share', 'opencode');
export const OPENCODE_CONFIG_VOLUME = `${OPENCODE_CONFIG_DIR}:/home/agent/.local/share/opencode`;

const checkConfig = async () => {
  await mkdir(OPENCODE_CONFIG_DIR, { recursive: true });

  const hostAuth = file(join(OPENCODE_HOST_CONFIG_DIR, 'auth.json'));
  if (!(await hostAuth.exists())) {
    log.info('Opencode auth.json not found in host config directory');
    return;
  }
  const localAuth = file(join(OPENCODE_CONFIG_DIR, 'auth.json'));
  if (!(await localAuth.exists())) {
    log.debug('Copying opencode auth.json from host to local config directory');
    await localAuth.write(await hostAuth.bytes());
  } else {
    const localContent = await localAuth.json();
    const hostContent = await hostAuth.json();
    const keys = new Set([
      ...Object.keys(localContent),
      ...Object.keys(hostContent),
    ]);
    let changed = false;
    for (const key of keys) {
      if (
        !localContent[key] ||
        (localContent[key].expires &&
          localContent[key].expires < Date.now() &&
          hostContent[key])
      ) {
        log.debug(
          `Adding missing or outdated key "${key}" to local opencode auth.json from host`,
        );
        localContent[key] = hostContent[key];
        changed = true;
      }
    }
    if (changed) {
      await localAuth.write(JSON.stringify(localContent, null, 2));
    }
  }
};

export const runOpencodeInDocker = async ({
  dockerArgs = ['--rm'],
  cmdArgs = [],
  dockerImage = HASHED_SANDBOX_DOCKER_IMAGE,
  interactive = false,
  shouldThrow = true,
}: RunInDockerOptionsBase): Promise<RunInDockerResult> => {
  await checkConfig();

  return runInDocker({
    dockerArgs: ['-v', OPENCODE_CONFIG_VOLUME, ...dockerArgs],
    cmdArgs,
    cmdName: 'opencode',
    dockerImage,
    interactive,
    shouldThrow,
  });
};

export const checkOpencodeCredentials = async (): Promise<boolean> => {
  const proc = await runOpencodeInDocker({
    cmdArgs: ['auth', 'list'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  const match = output.match(/(\d+)\s+credentials/);
  const numCreds = match?.[1] ? parseInt(match[1], 10) : 0;
  log.debug({ exitCode, output, numCreds }, 'checkOpencodeCredentials');
  return exitCode === 0 && numCreds > 0;
};
