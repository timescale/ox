// ============================================================================
// Ghost Authentication Service
// ============================================================================

import { nanoid } from 'nanoid';
import { getExistingEnvFilePaths, toEnvFileArgs } from '../utils/envFiles.ts';
import {
  captureGhostCredentialsFromContainer,
  checkGhostCredentials,
  invalidateGhostCredsCache,
  resolveGhostDockerImage,
} from './ghost';
import { log } from './logger';

// ============================================================================
// Container-based Interactive Auth
// ============================================================================

export interface GhostAuthProcess {
  /** The device code info parsed from ghost output */
  code: string;
  url: string;
  /** Promise that resolves when auth completes (true) or fails (false) */
  waitForCompletion: () => Promise<boolean>;
  /** Kill the process if user cancels */
  cancel: () => void;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelReader(reader: {
  cancel: () => Promise<void>;
}): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancellation errors during cleanup
  }
}

/**
 * Start ghost login in a Docker container and parse the device code.
 * Returns a handle to wait for completion or cancel.
 *
 * Uses a straightforward `docker run` — no files need to be injected
 * beforehand since `ghost login` doesn't need existing credentials
 * to start the OAuth device flow. After login completes, credentials
 * are captured from the stopped container via `docker cp`.
 */
export async function startContainerGhostAuth(): Promise<GhostAuthProcess | null> {
  const ghostImage = await resolveGhostDockerImage();
  const containerName = `ox-ghost-auth-${nanoid()}`;

  const envFilePaths = await getExistingEnvFilePaths({
    provider: 'docker',
    agent: undefined,
  });
  const envFileArgs = toEnvFileArgs(envFilePaths);

  log.trace({ envFilePaths }, 'Ghost auth container env files');

  const proc = Bun.spawn(
    [
      'docker',
      'run',
      '-i',
      ...envFileArgs,
      '--name',
      containerName,
      ghostImage,
      'ghost',
      'login',
      '--headless',
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const cleanup = () => {
    proc.kill();
    Bun.$`docker rm -f ${containerName}`.quiet().nothrow();
  };

  // Read initial output to get the device code.
  // Ghost uses GitHub OAuth and may output the code to stdout or stderr.
  // Expected format:
  // ! First copy your one-time code: XXXX-XXXX
  // Open this URL to continue in your web browser: https://github.com/login/device

  const decoder = new TextDecoder();
  let stderrBuffer = '';
  let stdoutBuffer = '';

  const stderrReader = proc.stderr?.getReader();
  const stdoutReader = proc.stdout?.getReader();

  if (!stderrReader || !stdoutReader) {
    cleanup();
    return null;
  }

  const startTime = Date.now();
  const TIMEOUT_MS = 10000;
  const hasDeviceCode = () => {
    const combined = stderrBuffer + stdoutBuffer;
    return combined.includes('enter code:') && combined.includes('http');
  };

  const stderrReadLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // Ignore - reader may be cancelled during cleanup
    } finally {
      try {
        stderrReader.releaseLock();
      } catch {
        // Ignore release errors during cleanup
      }
    }
  })();

  const stdoutReadLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // Ignore - reader may be cancelled during cleanup
    } finally {
      try {
        stdoutReader.releaseLock();
      } catch {
        // Ignore release errors during cleanup
      }
    }
  })();

  while (Date.now() - startTime < TIMEOUT_MS && !hasDeviceCode()) {
    await sleep(25);
  }

  // Parse the device code and URL from combined output.
  // Ghost CLI outputs:
  //   To authenticate, visit: https://github.com/login/device
  //   and enter code: XXXX-XXXX
  const combined = stderrBuffer + stdoutBuffer;
  const codeMatch = combined.match(/enter code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
  const code = codeMatch?.[1] ?? '';
  const urlMatch = combined.match(/(https:\/\/github\.com\/login\/device)/i);
  const url = urlMatch?.[1] ?? '';

  if (!code || !url) {
    log.warn(
      { combined: combined.trim() },
      'Failed to parse Ghost device code from login output',
    );
    await Promise.allSettled([
      cancelReader(stderrReader),
      cancelReader(stdoutReader),
      stderrReadLoop,
      stdoutReadLoop,
    ]);
    cleanup();
    return null;
  }

  return {
    code,
    url,
    waitForCompletion: async () => {
      log.debug('Ghost auth: waiting for process to exit');
      const exitCode = await proc.exited;
      log.debug({ exitCode }, 'Ghost auth: process exited');
      await Promise.allSettled([stderrReadLoop, stdoutReadLoop]);
      log.debug(
        {
          exitCode,
          stdout: stdoutBuffer.trim().slice(0, 200),
          stderr: stderrBuffer.trim().slice(0, 200),
        },
        'Ghost auth: streams drained',
      );

      if (exitCode !== 0) {
        log.debug({ exitCode }, 'Ghost auth: login failed');
        cleanup();
        return false;
      }

      // Capture credentials from the stopped container
      const captured =
        await captureGhostCredentialsFromContainer(containerName);
      log.debug({ captured }, 'Ghost auth: credential capture result');
      if (!captured) {
        log.debug('Failed to capture Ghost credentials from auth container');
      }
      cleanup();

      invalidateGhostCredsCache();
      const valid = await checkGhostCredentials();
      log.debug({ valid }, 'Ghost auth: post-login credential check');
      return valid;
    },
    cancel: cleanup,
  };
}
