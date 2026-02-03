import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import { readConfig } from './config';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
} from './runInDocker';

const HERMES_DIR = join(process.cwd(), '.hermes');
const OPENCODE_CONFIG_DIR = join(HERMES_DIR, '.local', 'share', 'opencode');
const OPENCODE_HOST_CONFIG_DIR = join(homedir(), '.local', 'share', 'opencode');
const OPENCODE_AUTH_FILE_NAME = 'auth.json';
export const OPENCODE_CONFIG_VOLUME = `${join(OPENCODE_CONFIG_DIR, OPENCODE_AUTH_FILE_NAME)}:/home/hermes/.local/share/opencode/${OPENCODE_AUTH_FILE_NAME}`;

const checkConfig = async () => {
  await mkdir(OPENCODE_CONFIG_DIR, { recursive: true });

  const hostAuth = file(
    join(OPENCODE_HOST_CONFIG_DIR, OPENCODE_AUTH_FILE_NAME),
  );
  if (!(await hostAuth.exists())) {
    log.info('Opencode auth.json not found in host config directory');
    return;
  }
  const localAuth = file(join(OPENCODE_CONFIG_DIR, OPENCODE_AUTH_FILE_NAME));
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
          `Adding missing or outdated key "${key}" to local opencode ${OPENCODE_AUTH_FILE_NAME} from host`,
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
  dockerImage,
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

export const checkOpencodeCredentials = async (
  model?: string,
): Promise<boolean> => {
  const proc = await runOpencodeInDocker({
    cmdArgs: ['auth', 'list'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  const match = output.match(/(\d+)\s+credentials/);
  const numCreds = match?.[1] ? parseInt(match[1], 10) : 0;
  log.debug(
    { exitCode, output, numCreds },
    'checkOpencodeCredentials auth list',
  );
  if (exitCode || !numCreds) {
    return false;
  }
  const effectiveModel = model ?? (await readConfig())?.model;
  const proc2 = await runOpencodeInDocker({
    cmdArgs: [
      'run',
      ...(effectiveModel ? ['--model', effectiveModel] : []),
      'just output `true`, and nothing else',
    ],
    shouldThrow: false,
  });
  const exitCode2 = await proc2.exited;
  const output2 = proc2.text().trim();
  const errText = proc2.errorText().trim();
  log.debug(
    { exitCode: exitCode2, output: output2, errText, model: effectiveModel },
    'checkOpencodeCredentials test run',
  );
  return exitCode2 === 0 && !errText.includes('Error');
};
