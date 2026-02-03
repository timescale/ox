import { $, spawn } from 'bun';
import { printArgs, resolveSandboxImage } from './docker';
import { log } from './logger';

export interface RunInDockerOptionsBase {
  dockerArgs?: readonly string[];
  cmdArgs?: readonly string[];
  dockerImage?: string;
  interactive?: boolean;
  shouldThrow?: boolean;
}

interface RunInDockerOptions extends RunInDockerOptionsBase {
  cmdName: string;
}

export interface RunInDockerResult {
  errorText: () => string;
  exited: Promise<number>;
  json: () => unknown;
  text: () => string;
}

export const runInDocker = async ({
  dockerArgs = ['--rm'],
  cmdArgs = [],
  cmdName,
  dockerImage,
  interactive = false,
  shouldThrow = true,
}: RunInDockerOptions): Promise<RunInDockerResult> => {
  // Resolve the sandbox image if not explicitly provided
  const resolvedImage = dockerImage ?? (await resolveSandboxImage()).image;
  log.debug(
    {
      dockerArgs,
      cmdArgs,
      cmdName,
      dockerImage: resolvedImage,
      interactive,
      shouldThrow,
      cmd: `docker run${interactive ? ' -it' : ''} ${printArgs(dockerArgs)} ${resolvedImage} ${cmdName} ${printArgs(cmdArgs)}`,
    },
    'runInDocker',
  );
  if (interactive) {
    const proc = spawn(
      [
        'docker',
        'run',
        '-it',
        ...dockerArgs,
        resolvedImage,
        cmdName,
        ...cmdArgs,
      ],
      {
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );
    if (shouldThrow) {
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`${cmdName} exited with code ${exitCode}`);
      }
    }
    return {
      exited: proc.exited,
      errorText: () => '',
      text: () => '',
      json: () => null,
    };
  }

  const proc =
    await $`docker run ${dockerArgs} ${resolvedImage} ${cmdName} ${cmdArgs}`
      .quiet()
      .throws(shouldThrow);
  return {
    errorText: () => proc.stderr.toString(),
    text: () => proc.text(),
    json: () => proc.json(),
    exited: Promise.resolve(proc.exitCode),
  };
};
