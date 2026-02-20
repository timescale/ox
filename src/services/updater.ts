// ============================================================================
// Auto-Update Service
// ============================================================================

import { chmod, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { log } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  releaseUrl: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

// ============================================================================
// Constants
// ============================================================================

const REPO = 'timescale/hermes';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Platform Detection
// ============================================================================

function getPlatformString(): string | null {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `hermes-${platform}-${arch}`;
}

// ============================================================================
// Binary Detection
// ============================================================================

/**
 * Returns true if hermes is running as a compiled binary (not from source via bun).
 * Also respects the HERMES_SKIP_UPDATE env var.
 */
export function isCompiledBinary(): boolean {
  if (process.env.HERMES_SKIP_UPDATE) {
    return false;
  }

  // When compiled with `bun build --compile`, the execPath is the binary itself.
  // When running from source (`./bun index.ts`), execPath ends with /bun or /bun.exe.
  const execPath = process.execPath;
  return !execPath.endsWith('/bun') && !execPath.endsWith('/bun.exe');
}

/**
 * Returns the path to the currently running binary.
 * Only meaningful when isCompiledBinary() returns true.
 */
export function getBinaryPath(): string {
  return process.execPath;
}

// ============================================================================
// Version Check
// ============================================================================

/**
 * Check GitHub for the latest release and compare against current version.
 * Returns UpdateInfo if an update is available, null if up-to-date.
 * Returns null (never throws) on any error — update checks must never break the app.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': `hermes/${packageJson.version}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.debug(
        { status: response.status },
        'GitHub releases API returned non-OK status',
      );
      return null;
    }

    const release = (await response.json()) as GitHubRelease;
    const latestVersion = release.tag_name.replace(/^v/, '');
    const currentVersion = packageJson.version;

    if (!isNewer(latestVersion, currentVersion)) {
      log.debug({ currentVersion, latestVersion }, 'Already on latest version');
      return null;
    }

    // Find the correct binary asset for this platform
    const binaryName = getPlatformString();
    if (!binaryName) {
      log.debug('Unsupported platform for auto-update');
      return null;
    }

    const asset = release.assets.find((a) => a.name === binaryName);
    if (!asset) {
      log.debug(
        { binaryName, availableAssets: release.assets.map((a) => a.name) },
        'No matching binary asset found in release',
      );
      return null;
    }

    return {
      currentVersion,
      latestVersion,
      downloadUrl: asset.browser_download_url,
      releaseUrl: release.html_url,
    };
  } catch (err) {
    log.debug({ err }, 'Failed to check for updates');
    return null;
  }
}

// ============================================================================
// Binary Update
// ============================================================================

export interface UpdateProgress {
  phase: 'downloading' | 'replacing' | 'complete';
  message: string;
}

/**
 * Download and replace the current binary with the new version.
 * The update takes effect on the next launch of hermes.
 *
 * @param info - Update info from checkForUpdate()
 * @param onProgress - Optional callback for progress updates
 * @throws on failure (caller should handle gracefully)
 */
export async function performUpdate(
  info: UpdateInfo,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  const binaryPath = getBinaryPath();
  const tempPath = join(dirname(binaryPath), `.hermes-update-${Date.now()}`);

  try {
    // Download
    onProgress?.({
      phase: 'downloading',
      message: `Downloading v${info.latestVersion}...`,
    });

    const response = await fetch(info.downloadUrl);

    if (!response.ok) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`,
      );
    }

    // Fully consume response body into memory before writing.
    // Bun.write(path, Response) can fail in compiled binaries,
    // so we materialise the bytes first.
    const bytes = await response.arrayBuffer();

    // Write to temp file
    await Bun.write(tempPath, bytes);

    // Make executable
    await chmod(tempPath, 0o755);

    // Replace
    onProgress?.({
      phase: 'replacing',
      message: 'Installing update...',
    });

    await rename(tempPath, binaryPath);

    onProgress?.({
      phase: 'complete',
      message: `Updated to v${info.latestVersion} (restart to apply)`,
    });

    log.info(
      {
        from: info.currentVersion,
        to: info.latestVersion,
      },
      'Binary updated successfully',
    );
  } catch (err) {
    // Clean up temp file on failure
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Simple semver comparison: returns true if `a` is newer than `b`.
 * Only handles standard major.minor.patch versions.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}
