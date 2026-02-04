import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { projectConfigDir } from './config';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
} from './runInDocker';

export const ghConfigDir = () => join(projectConfigDir(), 'gh');
export const ghConfigHostsFile = () => join(ghConfigDir(), 'hosts.yml');
export const ghConfigVolume = () => `${ghConfigDir()}:/home/hermes/.config/gh`;

/**
 * Returns the Docker volume mount string for gh credentials.
 * Always returns a valid volume string since ensureCredentialsFile creates the file if needed.
 */
export const getGhConfigVolume = async (): Promise<string> => {
  await mkdir(ghConfigDir(), { recursive: true });
  return ghConfigVolume();
};

export const runGhInDocker = async ({
  dockerArgs = ['--rm'],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
}: RunInDockerOptionsBase): Promise<RunInDockerResult> => {
  const configVolume = await getGhConfigVolume();

  return runInDocker({
    dockerArgs: ['-v', configVolume, ...dockerArgs],
    cmdArgs,
    cmdName: 'gh',
    dockerImage,
    interactive,
    shouldThrow,
  });
};

export const checkGhCredentials = async (): Promise<boolean> => {
  const proc = await runGhInDocker({
    cmdArgs: ['auth', 'status'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  log.debug({ exitCode, output }, 'checkGhCredentials');
  return exitCode === 0;
};

async function getHostGhCreds(): Promise<null | {
  token: string;
  user: string;
}> {
  try {
    const tokenResult = await Bun.$`gh auth token -h github.com`.quiet();
    const token = tokenResult.stdout.toString().trim() || null;
    if (!token) return null;
    const userResult =
      await Bun.$`gh api user --jq '.login' 2>/dev/null`.quiet();
    const user = userResult.stdout.toString().trim() || null;
    if (!user) return null;
    return { token, user };
  } catch {
    return null;
  }
}

export async function applyHostGhCreds(): Promise<boolean> {
  // attempt to use host credentials
  const hostCreds = await getHostGhCreds();
  if (hostCreds) {
    const file = ghConfigHostsFile();
    await Bun.write(
      file,
      YAML.stringify({
        'github.com': {
          oauth_token: hostCreds.token,
          user: hostCreds.user,
          git_protocol: 'https',
        },
      }),
    );

    // Set restrictive permissions on the hosts file
    await chmod(file, 0o600);
    if (await checkGhCredentials()) {
      log.debug('Successfully imported host credentials for gh');
      return true;
    }
    log.debug('Failed to import host credentials for gh');
  } else {
    log.debug('No host credentials found for gh');
  }

  return false;
}
