// ============================================================================
// Claude Authentication Service
// ============================================================================

import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { $ } from 'bun';
import { nanoid } from 'nanoid';
import { baseConfig, captureClaudeCredentialsFromContainer } from './claude';
import { resolveSandboxImage } from './docker';
import { CONTAINER_HOME, writeFileToContainer } from './dockerFiles';
import { log } from './logger';

// ============================================================================
// Types
// ============================================================================

export type ClaudeLoginMethod = 1 | 2;

export interface ClaudeAuthProcess {
  /** Select login method by sending the number key */
  selectLoginMethod: (method: ClaudeLoginMethod) => void;

  /** Wait for URL to appear after method selection, returns the URL */
  waitForUrl: () => Promise<string>;

  /** Submit the auth code - resolves after the code and Enter key have been sent */
  submitCode: (code: string) => Promise<void>;

  /** Wait for login completion - resolves true on success, false on failure */
  waitForCompletion: () => Promise<boolean>;

  /** Kill the process (for cancellation) */
  cancel: () => void;

  /** Get the current output buffer (for debugging) */
  getOutput: () => string;
}

export const LOGIN_METHOD_OPTIONS = [
  {
    name: 'Claude account with subscription',
    description: 'Pro, Max, Team, or Enterprise',
    value: 1 as ClaudeLoginMethod,
  },
  {
    name: 'Anthropic Console account',
    description: 'API usage billing',
    value: 2 as ClaudeLoginMethod,
  },
] as const;

// ============================================================================
// Container-based Interactive Auth using Bun's Terminal API
// ============================================================================

const MANUAL_LOGIN_HINT = 'Try running: ox claude /login';

/**
 * Start Claude login using Bun's PTY support.
 * Returns a handle to interact with the login flow.
 *
 * Uses `claude /login` to go directly into the login flow.
 */
export async function startClaudeAuth(): Promise<ClaudeAuthProcess | null> {
  const sandbox = await resolveSandboxImage();

  log.debug('Starting Claude login via Bun Terminal API');

  let outputBuffer = '';
  let urlResolve: ((url: string) => void) | null = null;
  let urlReject: ((err: Error) => void) | null = null;
  let completionResolve: ((success: boolean) => void) | null = null;
  // Track buffer position when code is submitted, so we only check new output
  let codeSubmittedAt = -1;
  // Track timeouts so we can clear them on cancel
  const timeouts: Timer[] = [];

  const containerName = `ox-claude-auth-${nanoid()}`;

  // Phase 1: Start the container detached with the signal entrypoint so we
  // can inject the .claude.json config file before claude /login starts.
  // This pre-populates hasCompletedOnboarding (skips theme selection, etc.)
  log.debug('Creating detached auth container');
  const createResult =
    await $`docker run -d -it --rm --entrypoint /.ox/signalEntrypoint.sh --name ${containerName} ${sandbox.image} claude /login`
      .quiet()
      .nothrow();
  if (createResult.exitCode) {
    log.error(
      { stderr: createResult.stderr.toString() },
      'Failed to create auth container',
    );
    return null;
  }
  const containerId = createResult.text().trim();

  // Stop the auth container synchronously. Uses spawnSync so it works
  // reliably during process teardown (async operations may not complete).
  // -t 2 keeps the grace period short (default 10s is too long).
  const stopContainer = () => {
    spawnSync('docker', ['stop', '-t', '2', containerId], { stdio: 'ignore' });
  };

  // Register a process exit handler to ensure the container is stopped if
  // process.exit() is called (e.g. from our renderer 'destroy' handler).
  process.on('exit', stopContainer);

  // Inject .claude.json with baseConfig to skip onboarding screens
  const configPath = `${CONTAINER_HOME}/.claude.json`;
  try {
    await writeFileToContainer(
      containerId,
      configPath,
      JSON.stringify(baseConfig),
    );
  } catch (err) {
    log.error({ err }, 'Failed to write .claude.json to auth container');
    process.off('exit', stopContainer);
    await $`docker rm -f ${containerId}`.quiet().nothrow();
    return null;
  }

  // Signal ready so the entrypoint starts `claude /login`
  await writeFileToContainer(containerId, '/.ox/signal/.ready', '1');

  // Phase 2: Attach to the container with a PTY to interact with the login flow
  log.debug('Attaching to auth container');
  const proc = Bun.spawn(['docker', 'attach', containerId], {
    terminal: {
      cols: 500, // Wide enough to keep URL on single line
      rows: 24,
      data(_terminal, data) {
        const text = new TextDecoder().decode(data);
        outputBuffer += text;

        // Strip ANSI codes for pattern matching
        const clean = stripVTControlCharacters(outputBuffer);

        // Check for URL (after method selected)
        if (urlResolve) {
          const urlMatch = clean.match(
            /(https:\/\/(claude\.ai|platform\.claude\.com)\/oauth[^\s]+)/,
          );
          const url = urlMatch?.[1];
          // Check for paste prompt (with or without spaces due to ANSI stripping)
          if (
            url &&
            (clean.includes('Paste code') || clean.includes('Pastecode'))
          ) {
            log.debug({ url }, 'Found authorization URL');
            urlResolve(url);
            urlResolve = null;
            urlReject = null;
          }
        }

        // Check for completion (with or without spaces due to ANSI stripping)
        // Only check output that came AFTER the code was submitted
        if (completionResolve && codeSubmittedAt >= 0) {
          const recentOutput = outputBuffer.slice(codeSubmittedAt);
          const cleanRecent = stripVTControlCharacters(recentOutput);
          if (
            cleanRecent.includes('Login successful') ||
            cleanRecent.includes('Loginsuccessful') ||
            cleanRecent.includes('Logged in as') ||
            cleanRecent.includes('Loggedinas')
          ) {
            log.debug('Login successful');
            captureClaudeCredentialsFromContainer(containerName).then(
              (success) => {
                completionResolve?.(success);
                completionResolve = null;
              },
            );
          } else if (
            cleanRecent.includes('Invalid') ||
            cleanRecent.includes('error') ||
            cleanRecent.includes('failed')
          ) {
            log.debug({ cleanRecent }, 'Login failed');
            completionResolve(false);
            completionResolve = null;
          }
        }
      },
    },
  });

  // Wait for login menu to appear
  // Note: stripVTControlCharacters removes escape codes but cursor movement
  // codes that represent spaces result in text without spaces, so we check both
  log.debug('Waiting for Claude login menu');
  const menuReady = await new Promise<boolean>((resolve) => {
    const startTime = Date.now();
    const MENU_TIMEOUT_MS = 30000;

    const checkInterval = setInterval(() => {
      const clean = stripVTControlCharacters(outputBuffer);
      if (
        clean.includes('Select login method') ||
        clean.includes('Selectloginmethod') ||
        clean.includes('Claude Code can be used') ||
        clean.includes('ClaudeCodecanbeused')
      ) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > MENU_TIMEOUT_MS) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 100);
  });

  if (!menuReady) {
    log.error({ output: outputBuffer }, 'Failed to detect Claude login menu');
    process.off('exit', stopContainer);
    stopContainer();
    return null;
  }

  log.debug('Claude login menu ready');

  return {
    selectLoginMethod: (method: ClaudeLoginMethod) => {
      log.debug({ method }, 'Selecting Claude login method');
      proc.terminal?.write(String(method));
    },

    waitForUrl: () => {
      return new Promise<string>((resolve, reject) => {
        urlResolve = resolve;
        urlReject = reject;

        // Check if URL is already in buffer
        const clean = stripVTControlCharacters(outputBuffer);
        const urlMatch = clean.match(
          /(https:\/\/(claude\.ai|platform\.claude\.com)\/oauth[^\s]+)/,
        );
        const url = urlMatch?.[1];
        if (
          url &&
          (clean.includes('Paste code') || clean.includes('Pastecode'))
        ) {
          log.debug({ url }, 'URL already in buffer');
          urlResolve(url);
          urlResolve = null;
          urlReject = null;
          return;
        }

        // Set timeout
        const URL_TIMEOUT_MS = 30000;
        timeouts.push(
          setTimeout(() => {
            if (urlReject) {
              urlReject(
                new Error(
                  `Timeout waiting for authorization URL. ${MANUAL_LOGIN_HINT}`,
                ),
              );
              urlResolve = null;
              urlReject = null;
            }
          }, URL_TIMEOUT_MS),
        );
      });
    },

    submitCode: (code: string) => {
      return new Promise<void>((resolve) => {
        log.debug('Submitting Claude auth code');
        // Mark position so waitForCompletion only checks output after this point
        codeSubmittedAt = outputBuffer.length;
        // Write code first, then Enter after a small delay
        // (Claude needs time to process the input)
        proc.terminal?.write(code);
        setTimeout(() => {
          proc.terminal?.write('\r');
          // Give a bit more time after Enter before resolving
          // so that output buffer has time to receive any response
          setTimeout(resolve, 200);
        }, 300);
      });
    },

    waitForCompletion: () => {
      return new Promise<boolean>((resolve, reject) => {
        if (codeSubmittedAt < 0) {
          reject(new Error('Code not submitted'));
          return;
        }
        completionResolve = resolve;

        // Wait up to 30 seconds
        timeouts.push(
          setTimeout(() => {
            if (!completionResolve) return;
            completionResolve(false);
            completionResolve = null;
          }, 30000),
        );
      });
    },

    cancel: () => {
      log.debug('Cancelling Claude login process');
      process.off('exit', stopContainer);
      // Clear all pending timeouts to allow process to exit
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.length = 0;
      stopContainer();
    },

    getOutput: () => outputBuffer,
  };
}
