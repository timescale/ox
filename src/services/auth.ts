// ============================================================================
// GitHub Authentication Service
// ============================================================================

import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { YAML } from 'bun';
import { projectConfigDir } from './config';
import { resolveSandboxImage } from './docker';

const ghConfigDir = () => join(projectConfigDir(), 'gh');
const GH_HOSTS_FILENAME = 'hosts.yml';
export const ghConfigVolume = () => `${ghConfigDir()}:/home/hermes/.config/gh`;

// ============================================================================
// Types
// ============================================================================

interface GhHostConfig {
  oauth_token: string;
  user: string;
  git_protocol: string;
}

interface GhHostsYaml {
  [hostname: string]: GhHostConfig;
}

// ============================================================================
// Host gh CLI Detection
// ============================================================================

/**
 * Check if gh CLI is installed on the host
 */
async function isGhInstalled(): Promise<boolean> {
  try {
    await Bun.$`which gh`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if host has gh auth for github.com
 * Note: This checks if a token exists, not if it's valid (network check)
 */
async function hasHostGhAuth(): Promise<boolean> {
  // Check if we can get a token (more reliable than status check)
  const token = await getHostGhToken();
  return token !== null;
}

/**
 * Get the gh auth token from the host
 */
async function getHostGhToken(): Promise<string | null> {
  try {
    const result = await Bun.$`gh auth token -h github.com`.quiet();
    const token = result.stdout.toString().trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Get the authenticated GitHub username from the host
 * Tries gh api first, falls back to parsing hosts.yml
 */
async function getHostGhUser(): Promise<string | null> {
  // Try gh api first (most accurate)
  try {
    const result = await Bun.$`gh api user --jq '.login' 2>/dev/null`.quiet();
    const user = result.stdout.toString().trim();
    if (user) return user;
  } catch {
    // Fall through to hosts.yml fallback
  }

  // Fallback: parse ~/.config/gh/hosts.yml directly
  try {
    const hostsFile = Bun.file(
      join(process.env.HOME || '', '.config', 'gh', 'hosts.yml'),
    );
    if (await hostsFile.exists()) {
      const content = await hostsFile.text();
      const hosts = YAML.parse(content) as GhHostsYaml | null;
      const user = hosts?.['github.com']?.user;
      if (user) return user;
    }
  } catch {
    // Fall through
  }

  return null;
}

// ============================================================================
// Local .hermes/gh Credential Management
// ============================================================================

/**
 * Check if we have valid gh credentials in .hermes/gh/
 */
export async function hasLocalGhAuth(): Promise<boolean> {
  const file = Bun.file(join(ghConfigDir(), GH_HOSTS_FILENAME));
  if (!(await file.exists())) {
    return false;
  }

  try {
    const content = await file.text();
    const hosts = YAML.parse(content) as GhHostsYaml | null;
    return !!hosts?.['github.com']?.oauth_token;
  } catch {
    return false;
  }
}

/**
 * Write gh credentials to .hermes/gh/hosts.yml
 */
async function writeGhCredentials(token: string, user: string): Promise<void> {
  const dir = ghConfigDir();
  await mkdir(dir, { recursive: true });

  const hosts: GhHostsYaml = {
    'github.com': {
      oauth_token: token,
      user,
      git_protocol: 'https',
    },
  };

  const file = join(dir, GH_HOSTS_FILENAME);
  await Bun.write(file, YAML.stringify(hosts));

  // Set restrictive permissions on the hosts file
  await chmod(file, 0o600);
}

/**
 * Export host gh credentials to .hermes/gh/
 * Returns true if successful, false otherwise
 */
async function exportHostGhAuth(): Promise<boolean> {
  const token = await getHostGhToken();
  if (!token) {
    return false;
  }

  const user = await getHostGhUser();
  if (!user) {
    return false;
  }

  await writeGhCredentials(token, user);
  return true;
}

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
 */
export async function startContainerGhAuth(): Promise<GhAuthProcess | null> {
  // Ensure the gh config directory exists
  await mkdir(ghConfigDir(), { recursive: true });

  // Resolve the sandbox image
  const imageConfig = await resolveSandboxImage();

  const proc = Bun.spawn(
    [
      'docker',
      'run',
      '-i', // Interactive but not TTY - we control the flow
      '--rm',
      '-v',
      ghConfigVolume(),
      imageConfig.image,
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

  // Read initial output to get the device code
  // Expected format:
  // ! First copy your one-time code: XXXX-XXXX
  // Open this URL to continue in your web browser: https://github.com/login/device

  const decoder = new TextDecoder();
  let stderrBuffer = '';

  // Read stderr until we get the device code, then continue draining
  const stderrReader = proc.stderr?.getReader();
  if (!stderrReader) {
    proc.kill();
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
    // Failed to parse, kill the process
    stderrReader.releaseLock();
    proc.kill();
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
        return false;
      }
      // Set restrictive permissions on the hosts file
      const file = join(ghConfigDir(), GH_HOSTS_FILENAME);
      const hostsFile = Bun.file(file);
      if (await hostsFile.exists()) {
        await chmod(file, 0o600);
      }
      return await hasLocalGhAuth();
    },
    cancel: () => {
      proc.kill();
    },
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

export interface EnsureGhAuthOptions {
  dockerImage: string;
}

export interface GhAuthResult {
  success: boolean;
  source: 'existing' | 'host' | 'container' | 'none';
  user?: string;
}

/**
 * Check and export host gh credentials if available.
 * Returns result if credentials were found/exported, null if container auth is needed.
 */
export async function tryHostGhAuth(): Promise<GhAuthResult | null> {
  // Check for existing local credentials
  if (await hasLocalGhAuth()) {
    return { success: true, source: 'existing' };
  }

  // Try to export from host gh CLI
  if (await isGhInstalled()) {
    if (await hasHostGhAuth()) {
      const user = await getHostGhUser();
      if (await exportHostGhAuth()) {
        return { success: true, source: 'host', user: user ?? undefined };
      }
    }
  }

  // Need container-based auth
  return null;
}
