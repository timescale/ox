// ============================================================================
// Ghost Authentication Service
// ============================================================================

import { nanoid } from 'nanoid';
import { getExistingEnvFilePaths, toEnvFileArgs } from '../utils/envFiles.ts';
import { resolveSandboxImage } from './docker';
import {
  captureGhostCredentialsFromContainer,
  checkGhostCredentials,
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
  const sandbox = await resolveSandboxImage();
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
      sandbox.image,
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

  // Read stderr for the device code
  const stderrReader = proc.stderr?.getReader();
  const stdoutReader = proc.stdout?.getReader();

  if (!stderrReader || !stdoutReader) {
    cleanup();
    return null;
  }

  // Read until we have the device code (with timeout)
  const startTime = Date.now();
  const TIMEOUT_MS = 10000;

  // Read both streams concurrently to find the code
  const hasDeviceCode = () => {
    const combined = stderrBuffer + stdoutBuffer;
    return combined.includes('one-time code:') && combined.includes('http');
  };

  // Read stderr in background
  const stderrReadLoop = (async () => {
    while (Date.now() - startTime < TIMEOUT_MS && !hasDeviceCode()) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrBuffer += decoder.decode(value, { stream: true });
    }
  })();

  // Read stdout in background
  const stdoutReadLoop = (async () => {
    while (Date.now() - startTime < TIMEOUT_MS && !hasDeviceCode()) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdoutBuffer += decoder.decode(value, { stream: true });
    }
  })();

  // Wait for either stream to find the code or timeout
  await Promise.race([
    Promise.all([stderrReadLoop, stdoutReadLoop]),
    new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS)),
  ]);

  // Parse the device code and URL from combined output
  const combined = stderrBuffer + stdoutBuffer;
  const codeMatch = combined.match(
    /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
  );
  const code = codeMatch?.[1] ?? '';
  const urlMatch = combined.match(/(https:\/\/github\.com\/login\/device)/i);
  const url = urlMatch?.[1] ?? '';

  if (!code || !url) {
    // Failed to parse
    stderrReader.releaseLock();
    stdoutReader.releaseLock();
    cleanup();
    return null;
  }

  // Continue draining stderr in background (don't await)
  // This prevents the process from blocking on write
  const stderrDrainPromise = (async () => {
    try {
      while (true) {
        const { done } = await stderrReader.read();
        if (done) break;
      }
    } catch {
      // Ignore - process may have been killed
    } finally {
      stderrReader.releaseLock();
    }
  })();

  // Continue draining stdout in background
  const stdoutDrainPromise = (async () => {
    try {
      while (true) {
        const { done } = await stdoutReader.read();
        if (done) break;
      }
    } catch {
      // Ignore - process may have been killed
    } finally {
      stdoutReader.releaseLock();
    }
  })();

  return {
    code,
    url,
    waitForCompletion: async () => {
      const exitCode = await proc.exited;
      // Wait for streams to finish draining
      await Promise.all([stderrDrainPromise, stdoutDrainPromise]);

      if (exitCode !== 0) {
        cleanup();
        return false;
      }

      // Capture credentials from the stopped container
      const captured =
        await captureGhostCredentialsFromContainer(containerName);
      if (!captured) {
        log.debug('Failed to capture Ghost credentials from auth container');
      }
      cleanup();

      return await checkGhostCredentials();
    },
    cancel: cleanup,
  };
}
