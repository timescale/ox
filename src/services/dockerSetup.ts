// ============================================================================
// Docker Setup Service - Detection and installation of Docker runtime
// ============================================================================

import {
  dockerIsRunning,
  ensureDockerInstalled,
  ensureDockerRunning,
  ensureOrbStackInstalled,
  ensureOrbStackRunning,
  isMac,
} from 'build-strap';

// ============================================================================
// Types
// ============================================================================

export type DockerProvider = 'docker-desktop' | 'orbstack';

export interface DockerStatus {
  isRunning: boolean;
  dockerDesktopInstalled: boolean;
  orbstackInstalled: boolean; // always false on non-Mac
  isMac: boolean;
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Check if Docker Desktop is installed by looking for the application
 */
export async function isDockerDesktopInstalled(): Promise<boolean> {
  if (isMac()) {
    return Bun.file('/Applications/Docker.app/Contents/Info.plist').exists();
  }
  // On Linux/Windows, check if docker command exists
  // (it could be from Docker Desktop or another source)
  try {
    await Bun.$`which docker`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if OrbStack is installed (Mac only)
 */
export async function isOrbStackInstalled(): Promise<boolean> {
  if (!isMac()) {
    return false;
  }
  return Bun.file('/Applications/OrbStack.app/Contents/Info.plist').exists();
}

/**
 * Check the current Docker status without modifying anything
 */
export async function checkDockerStatus(): Promise<DockerStatus> {
  const [isRunning, dockerDesktopInstalled, orbstackInstalled] =
    await Promise.all([
      dockerIsRunning(),
      isDockerDesktopInstalled(),
      isOrbStackInstalled(),
    ]);

  return {
    isRunning,
    dockerDesktopInstalled,
    orbstackInstalled,
    isMac: isMac(),
  };
}

// ============================================================================
// Installation Functions
// ============================================================================

/**
 * Install the specified Docker provider
 */
export async function installProvider(provider: DockerProvider): Promise<void> {
  if (provider === 'orbstack') {
    if (!isMac()) {
      throw new Error('OrbStack is only available on macOS');
    }
    // Use our own implementation to capture output on failure
    const result = await ensureOrbStackInstalled({
      captureOutput: true,
      rejectOnErrorCode: false,
    });
    if (result?.code) {
      throw new Error(`Failed to install OrbStack.\n\n${result.output}`);
    }
  } else {
    // For Docker Desktop, use build-strap's implementation
    // It downloads and installs a DMG, which has its own error handling
    try {
      await ensureDockerInstalled();
    } catch (err: unknown) {
      const error = err as { message?: string };
      throw new Error(
        `Failed to install Docker Desktop.\n\n${error.message ?? String(err)}`,
      );
    }
  }
}

// ============================================================================
// Startup Functions
// ============================================================================

/**
 * Start the specified Docker provider and wait for Docker to be ready
 * @param provider The provider to start
 * @param timeoutSeconds Maximum time to wait for Docker to be ready (default: 600)
 * @param onProgress Optional callback for progress updates
 */
export async function startProvider(
  provider: DockerProvider,
  timeoutSeconds = 600,
  onProgress?: (message: string) => void,
): Promise<void> {
  const log = onProgress ?? (() => {});

  if (await dockerIsRunning()) {
    log('Docker is already running');
    return;
  }

  if (provider === 'orbstack') {
    if (!isMac()) {
      throw new Error('OrbStack is only available on macOS');
    }
    log('Starting OrbStack');
    await ensureOrbStackRunning(timeoutSeconds);
  } else {
    if (isMac()) {
      log('Starting Docker Desktop');
      await ensureDockerRunning(timeoutSeconds);
    } else {
      throw new Error(
        'Docker is not running. Please start Docker Desktop manually.',
      );
    }
  }

  log('Docker is ready');
}

/**
 * Ensure Docker is running, installing and starting as needed.
 * This is a convenience function that handles the full flow without UI.
 * For UI-based setup, use the DockerSetup component instead.
 */
export async function ensureDockerReady(
  preferredProvider?: DockerProvider,
): Promise<void> {
  const status = await checkDockerStatus();

  if (status.isRunning) {
    return;
  }

  // Determine which provider to use
  let provider: DockerProvider;

  if (preferredProvider) {
    provider = preferredProvider;
  } else if (status.orbstackInstalled && !status.dockerDesktopInstalled) {
    provider = 'orbstack';
  } else if (status.dockerDesktopInstalled && !status.orbstackInstalled) {
    provider = 'docker-desktop';
  } else if (status.orbstackInstalled) {
    // Both installed - prefer OrbStack
    provider = 'orbstack';
  } else {
    // Neither installed - default to OrbStack on Mac, Docker Desktop elsewhere
    provider = status.isMac ? 'orbstack' : 'docker-desktop';
  }

  // Install if needed
  if (provider === 'orbstack' && !status.orbstackInstalled) {
    await installProvider('orbstack');
  } else if (provider === 'docker-desktop' && !status.dockerDesktopInstalled) {
    await installProvider('docker-desktop');
  }

  // Start the provider
  await startProvider(provider);
}

// Re-export useful functions from build-strap
export { dockerIsRunning, isMac };
