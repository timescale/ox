import path from 'node:path';
import { $, spawn } from 'bun';
import { nanoid } from 'nanoid';
import { Deferred } from '../types/deferred';
import { printArgs, resolveSandboxImage } from './docker';
import { writeFileToContainer } from './dockerFiles';
import { log } from './logger';

export interface VirtualFile {
  value: string;
  path: string;
}

export interface RunInDockerOptionsBase {
  containerName?: string;
  dockerArgs?: readonly string[];
  cmdArgs?: readonly string[];
  dockerImage?: string;
  interactive?: boolean;
  detached?: boolean;
  shouldThrow?: boolean;
  files?: VirtualFile[];
  mountCwd?: boolean | string;
  /** Docker container labels as key-value pairs (expanded to --label args) */
  labels?: Record<string, string>;
}

interface RunInDockerOptions extends RunInDockerOptionsBase {
  cmdName: string;
}

export interface RunInDockerResult {
  containerId: string | null;
  errorText: () => string;
  exited: Promise<number>;
  removed: Promise<void>;
  json: () => unknown;
  text: () => string;
  rm: (shouldThrow?: boolean) => Promise<void>;
}

export const runInDocker = async ({
  containerName = `hermes-anon-${nanoid(12)}`,
  dockerArgs = ['--rm'],
  cmdName,
  cmdArgs = [],
  dockerImage,
  interactive = false,
  detached = false,
  shouldThrow = true,
  files = [],
  mountCwd = false,
  labels = {},
}: RunInDockerOptions): Promise<RunInDockerResult> => {
  const resolvedImage = dockerImage ?? (await resolveSandboxImage()).image;
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => [
    '--label',
    `${k}=${v}`,
  ]);
  const effectiveDockerArgs = [
    // Always start detached, so we can get the containerId and potentially write files before starting the main process
    '-d',
    '--entrypoint',
    '/.hermes/signalEntrypoint.sh',
    '--name',
    containerName,
    // We need -it even when detached for interactive mode to work properly in the subsequent docker attach
    ...(interactive ? ['-it'] : []),
    ...dockerArgs,
    ...labelArgs,
    ...(mountCwd
      ? [
          '-v',
          `${path.resolve(mountCwd === true ? process.cwd() : mountCwd)}:/work/app`,
          '-w',
          '/work/app',
        ]
      : []),
  ];
  log.debug(
    {
      containerName,
      dockerArgs,
      cmdArgs,
      cmdName,
      dockerImage: resolvedImage,
      interactive,
      detached,
      shouldThrow,
      files: files.map((f) => f.path),
      mountCwd,
      cmd: `docker run ${printArgs(effectiveDockerArgs)} ${resolvedImage} ${cmdName} ${printArgs(cmdArgs)}`,
    },
    'runInDocker',
  );
  const containerProc =
    await $`docker run ${effectiveDockerArgs} ${resolvedImage} ${cmdName} ${cmdArgs}`
      .quiet()
      .throws(shouldThrow);
  if (containerProc.exitCode) {
    // Failed, but didn't throw, so return the error
    return {
      containerId: null,
      errorText: () => containerProc.stderr.toString(),
      text: () => containerProc.text(),
      json: () => containerProc.json(),
      exited: Promise.resolve(containerProc.exitCode),
      rm: () => Promise.resolve(),
      removed: Promise.resolve(),
    };
  }
  const containerId = containerProc.text().trim();
  if (!containerId) {
    // Unexpected
    throw new Error(`Failed to create container`);
  }

  // write any files into the container
  await Promise.all(
    files.map((file) =>
      writeFileToContainer(containerId, file.path, file.value),
    ),
  );

  const deferredResult = new Deferred<RunInDockerResult>();
  const deferredRemoved = new Deferred<void>();
  if (interactive) {
    const proc = spawn(
      ['docker', 'attach', '--detach-keys=ctrl-\\', containerId],
      {
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );
    deferredResult.wrap(async () => {
      if (shouldThrow) {
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          throw new Error(`${cmdName} exited with code ${exitCode}`);
        }
      }
      return {
        containerId,
        exited: proc.exited,
        errorText: () => '',
        text: () => '',
        json: () => null,
        rm: (shouldThrow) =>
          deferredRemoved.wrap(dockerContainerRm(containerId, shouldThrow)),
        removed: deferredRemoved.promise,
      };
    });
  } else if (!detached) {
    deferredResult.wrap(
      $`docker attach --no-stdin ${containerId}`
        .quiet()
        .throws(shouldThrow)
        .then((proc) => ({
          containerId,
          errorText: () => proc.stderr.toString(),
          text: () => proc.text(),
          json: () => proc.json(),
          exited: Promise.resolve(proc.exitCode),
          rm: (shouldThrow) =>
            deferredRemoved.wrap(dockerContainerRm(containerId, shouldThrow)),
          removed: deferredRemoved.promise,
        })),
    );
  } else {
    deferredResult.resolve({
      containerId,
      errorText: () => containerProc.stderr.toString(),
      text: () => containerProc.text(),
      json: () => containerProc.json(),
      exited: Promise.resolve(containerProc.exitCode),
      rm: (shouldThrow) =>
        deferredRemoved.wrap(dockerContainerRm(containerId, shouldThrow)),
      removed: deferredRemoved.promise,
    });
  }

  // signal ready
  await writeFileToContainer(containerId, '/.hermes/signal/.ready', '1');

  if (dockerArgs.includes('--rm')) {
    deferredResult.promise.then((proc) => {
      proc.exited.finally(deferredRemoved.resolve);
    });
  }

  return deferredResult.promise;
};

const dockerContainerRm = async (containerId: string, shouldThrow = true) => {
  log.debug({ containerId }, 'dockerContainerRm');
  await $`docker container rm ${containerId}`.quiet().throws(shouldThrow);
};
