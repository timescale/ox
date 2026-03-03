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
  /**
   * Allocate a TTY (-it flags) without attaching to it.
   * Useful when you want to start the container detached but later attach
   * interactively via `docker attach`.  When true, `-it` flags are added
   * to the `docker run` command even when `detached` is true.
   * Only meaningful when `detached` is true (when `interactive` is true
   * the TTY is always allocated).
   */
  allocateTty?: boolean;
  shouldThrow?: boolean;
  files?: VirtualFile[];
  mountCwd?: boolean | string;
  /** Docker container labels as key-value pairs (expanded to --label args) */
  labels?: Record<string, string>;
  /**
   * Optional AbortSignal to cancel the container run.
   * When aborted, the container is forcibly removed (`docker rm -f`) and the
   * returned promise resolves with a no-op stub result.
   * Only effective for non-interactive, non-detached runs.
   */
  signal?: AbortSignal;
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

/** Return a no-op stub result. Used when the signal is aborted so that
 *  the returned promise resolves (never rejects) — callers may not have
 *  .catch() handlers attached when abort fires synchronously during React
 *  cleanup. */
const abortedStubResult = (
  containerId: string | null = null,
): RunInDockerResult => ({
  containerId,
  errorText: () => '',
  text: () => '',
  json: () => null,
  exited: Promise.resolve(1),
  rm: () => Promise.resolve(),
  removed: Promise.resolve(),
});

/** Force-remove a container (fire-and-forget) and return an aborted stub. */
const abortAndRemoveContainer = (containerId: string): RunInDockerResult => {
  log.debug({ containerId }, 'Aborting runInDocker — removing container');
  $`docker rm -f ${containerId}`.quiet().catch(() => {});
  return abortedStubResult(containerId);
};

export const runInDocker = async ({
  containerName = `ox-anon-${nanoid(12)}`,
  dockerArgs = ['--rm'],
  cmdName,
  cmdArgs = [],
  dockerImage,
  interactive = false,
  detached = false,
  allocateTty = false,
  shouldThrow = true,
  files = [],
  mountCwd = false,
  labels = {},
  signal,
}: RunInDockerOptions): Promise<RunInDockerResult> => {
  // Bail early if already aborted.
  if (signal?.aborted) {
    return abortedStubResult();
  }

  const resolvedImage = dockerImage ?? (await resolveSandboxImage()).image;

  // Check after potentially slow image resolution.
  if (signal?.aborted) {
    return abortedStubResult();
  }

  const labelArgs = Object.entries(labels).flatMap(([k, v]) => [
    '--label',
    `${k}=${v}`,
  ]);
  const effectiveDockerArgs = [
    // Always start detached, so we can get the containerId and potentially write files before starting the main process
    '-d',
    '--entrypoint',
    '/.ox/signalEntrypoint.sh',
    '--name',
    containerName,
    // Allocate a TTY when interactive or when explicitly requested for later attachment
    ...(interactive || allocateTty ? ['-it'] : []),
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

  // Check after container creation — if aborted, clean up immediately.
  if (signal?.aborted) {
    return abortAndRemoveContainer(containerId);
  }

  // write any files into the container
  await Promise.all(
    files.map((file) =>
      writeFileToContainer(containerId, file.path, file.value),
    ),
  );

  // Check after file writes.
  if (signal?.aborted) {
    return abortAndRemoveContainer(containerId);
  }

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
    // Check once more before spawning the attach process.
    if (signal?.aborted) {
      return abortAndRemoveContainer(containerId);
    }

    // Use Bun.spawn so we get a killable subprocess handle for abort support.
    const attachProc = spawn(['docker', 'attach', '--no-stdin', containerId], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Eagerly buffer stdout/stderr so text()/errorText() can be sync after exited.
    const stdoutPromise = new Response(attachProc.stdout).text();
    const stderrPromise = new Response(attachProc.stderr).text();

    // Wire up abort: kill the attach process and force-remove the container.
    if (signal) {
      const onAbort = () => {
        try {
          log.debug({ containerId }, 'Aborting runInDocker container');
          attachProc.kill();
          $`docker rm -f ${containerId}`.quiet().catch(() => {});
        } catch (err) {
          log.debug({ err, containerId }, 'Error during runInDocker abort');
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        // Clean up the listener once the process exits naturally.
        attachProc.exited.finally(() =>
          signal.removeEventListener('abort', onAbort),
        );
      }
    }

    deferredResult.wrap(
      attachProc.exited.then(async (exitCode) => {
        // If aborted, return a stub result so the promise resolves (not rejects).
        if (signal?.aborted) {
          return abortedStubResult(containerId);
        }
        const stdoutText = await stdoutPromise;
        const stderrText = await stderrPromise;
        if (shouldThrow && exitCode !== 0) {
          throw new Error(`${cmdName} exited with code ${exitCode}`);
        }
        return {
          containerId,
          errorText: () => stderrText,
          text: () => stdoutText,
          json: () => JSON.parse(stdoutText),
          exited: Promise.resolve(exitCode),
          rm: (shouldThrow) =>
            deferredRemoved.wrap(dockerContainerRm(containerId, shouldThrow)),
          removed: deferredRemoved.promise,
        } satisfies RunInDockerResult;
      }),
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

  // Check before the final file write.
  if (signal?.aborted) {
    return abortAndRemoveContainer(containerId);
  }

  // signal ready
  await writeFileToContainer(containerId, '/.ox/signal/.ready', '1');

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
