// ============================================================================
// Claude Authentication Service
// ============================================================================

import { stripVTControlCharacters } from 'node:util';
import { getClaudeConfigVolume } from './claude';
import { resolveSandboxImage } from './docker';
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

const MANUAL_LOGIN_HINT = 'Try running: hermes claude /login';

/**
 * Start Claude login using Bun's PTY support.
 * Returns a handle to interact with the login flow.
 *
 * Uses `claude /login` to go directly into the login flow.
 */
export async function startClaudeAuth(): Promise<ClaudeAuthProcess | null> {
  const sandbox = await resolveSandboxImage();
  const configVolume = await getClaudeConfigVolume();

  log.debug('Starting Claude login via Bun Terminal API');

  let outputBuffer = '';
  let urlResolve: ((url: string) => void) | null = null;
  let urlReject: ((err: Error) => void) | null = null;
  let completionResolve: ((success: boolean) => void) | null = null;
  // Track buffer position when code is submitted, so we only check new output
  let codeSubmittedAt = -1;
  // Track timeouts so we can clear them on cancel
  const timeouts: Timer[] = [];

  const proc = Bun.spawn(
    [
      'docker',
      'run',
      '-it',
      '--rm',
      '-v',
      configVolume,
      sandbox.image,
      'claude',
      '/login',
    ],
    {
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
            const urlMatch = clean.match(/(https:\/\/claude\.ai\/oauth[^\s]+)/);
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
              completionResolve(true);
              completionResolve = null;
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
    },
  );

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
    proc.kill();
    proc.terminal?.close();
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
        const urlMatch = clean.match(/(https:\/\/claude\.ai\/oauth[^\s]+)/);
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
      return new Promise<boolean>((resolve) => {
        completionResolve = resolve;

        // Only check output that came AFTER the code was submitted
        if (codeSubmittedAt < 0) {
          // Code hasn't been submitted yet, just wait
          log.debug('waitForCompletion called before code submitted');
        } else {
          const recentOutput = outputBuffer.slice(codeSubmittedAt);
          const cleanRecent = stripVTControlCharacters(recentOutput);

          // Check if already completed (with or without spaces due to ANSI stripping)
          if (
            cleanRecent.includes('Login successful') ||
            cleanRecent.includes('Loginsuccessful') ||
            cleanRecent.includes('Logged in as') ||
            cleanRecent.includes('Loggedinas')
          ) {
            log.debug('Already logged in');
            completionResolve(true);
            completionResolve = null;
            return;
          }
          if (
            cleanRecent.includes('Invalid') ||
            cleanRecent.includes('error') ||
            cleanRecent.includes('failed')
          ) {
            log.debug({ cleanRecent }, 'Already failed');
            completionResolve(false);
            completionResolve = null;
            return;
          }
        }

        // Set timeout
        const COMPLETION_TIMEOUT_MS = 60000;
        timeouts.push(
          setTimeout(() => {
            if (completionResolve) {
              log.debug('Completion timeout');
              completionResolve(false);
              completionResolve = null;
            }
          }, COMPLETION_TIMEOUT_MS),
        );
      });
    },

    cancel: () => {
      log.debug('Cancelling Claude login process');
      // Clear all pending timeouts to allow process to exit
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      timeouts.length = 0;
      proc.kill();
      proc.terminal?.close();
    },

    getOutput: () => outputBuffer,
  };
}
