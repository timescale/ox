// ============================================================================
// GitHub Authentication Service
// ============================================================================

import { nanoid } from 'nanoid';
import { resolveSandboxImage } from './docker';
import { captureGhCredentialsFromContainer, checkGhCredentials } from './gh';
import { log } from './logger';

// ============================================================================
// Container-based Interactive Auth
// ============================================================================

export interface GhAuthProcess {
  /** The device code info parsed from gh output */
  code: string;
  url: string;
  /** Promise that resolves when auth completes (true) or fails (false) */
  waitForCompletion: () => Promise<boolean>;
  /** Kill the process if user cancels */
  cancel: () => void;
}

/**
 * Drain a stream in the background (to prevent process from blocking)
 */
async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Ignore errors (stream may be cancelled)
  } finally {
    reader.releaseLock();
  }
}

/**
 * Start gh auth login in a Docker container and parse the device code.
 * Returns a handle to wait for completion or cancel.
 *
 * Uses a straightforward `docker run` — no files need to be injected
 * beforehand since `gh auth login` doesn't need existing credentials
 * to start the OAuth device flow. After login completes, credentials
 * are captured from the stopped container via `docker cp`.
 */
export async function startContainerGhAuth(): Promise<GhAuthProcess | null> {
  const sandbox = await resolveSandboxImage();
  const containerName = `hermes-gh-auth-${nanoid()}`;

  const proc = Bun.spawn(
    [
      'docker',
      'run',
      '-i',
      '--name',
      containerName,
      sandbox.image,
      'gh',
      'auth',
      'login',
      '-h',
      'github.com',
      '-p',
      'https',
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

  // Read initial output to get the device code
  // Expected format:
  // ! First copy your one-time code: XXXX-XXXX
  // Open this URL to continue in your web browser: https://github.com/login/device

  const decoder = new TextDecoder();
  let stderrBuffer = '';

  // Read stderr until we get the device code, then continue draining
  const stderrReader = proc.stderr?.getReader();
  if (!stderrReader) {
    cleanup();
    return null;
  }

  // Read until we have the device code (with timeout)
  const startTime = Date.now();
  const TIMEOUT_MS = 10000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    stderrBuffer += decoder.decode(value, { stream: true });

    // Check if we have both code and URL
    if (
      stderrBuffer.includes('one-time code:') &&
      stderrBuffer.includes('http')
    ) {
      break;
    }
  }

  // Parse the device code and URL
  const codeMatch = stderrBuffer.match(
    /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i,
  );
  const code = codeMatch?.[1] ?? '';
  const urlMatch = stderrBuffer.match(
    /(https:\/\/github\.com\/login\/device)/i,
  );
  const url = urlMatch?.[1] ?? '';

  if (!code || !url) {
    // Failed to parse
    stderrReader.releaseLock();
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

  // Also drain stdout in background
  const stdoutDrainPromise = drainStream(proc.stdout);

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
      const captured = await captureGhCredentialsFromContainer(containerName);
      if (!captured) {
        log.debug('Failed to capture gh credentials from auth container');
      }
      cleanup();

      return await checkGhCredentials();
    },
    cancel: cleanup,
  };
}
