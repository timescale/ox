// ============================================================================
// Docker Setup Component - TUI wizard step for Docker runtime setup
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureDockerImage, type ImageBuildProgress } from '../services/docker';
import {
  checkDockerStatus,
  type DockerProvider,
  type DockerStatus,
  installProvider,
  startProvider,
} from '../services/dockerSetup';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';
import { CopyOnSelect } from './CopyOnSelect';
import { Loading } from './Loading';
import { Selector } from './Selector';

// ============================================================================
// Types
// ============================================================================

export type DockerSetupResultType = 'ready' | 'cancelled' | 'error';

export interface DockerSetupResult {
  type: DockerSetupResultType;
  error?: string;
}

export interface DockerSetupProps {
  /** Title to show in the UI (e.g., "Step 1/4: Docker Setup") */
  title?: string;
  /** Called when Docker setup completes, is cancelled, or errors */
  onComplete: (result: DockerSetupResult) => void;
  /** Whether to show back button (for wizard integration) */
  showBack?: boolean;
  /** Called when back is pressed */
  onBack?: () => void;
}

type SetupState =
  | { type: 'checking' }
  | { type: 'ready' }
  | { type: 'starting'; provider: DockerProvider; message: string }
  | { type: 'select-provider'; status: DockerStatus }
  | { type: 'installing'; provider: DockerProvider }
  | { type: 'building-image'; message: string }
  | { type: 'error'; message: string };

// ============================================================================
// Provider Selection Options
// ============================================================================

function getProviderOptions(status: DockerStatus): SelectOption[] {
  const options: SelectOption[] = [];

  // OrbStack first (recommended) - Mac only
  if (status.isMac) {
    options.push({
      name: status.orbstackInstalled
        ? 'OrbStack (Recommended)'
        : 'Install OrbStack (Recommended)',
      description: status.orbstackInstalled
        ? 'Lightweight Docker runtime for Mac - already installed'
        : 'Lightweight, fast Docker runtime for Mac - will be installed via Homebrew',
      value: 'orbstack',
    });
  }

  // Docker Desktop
  options.push({
    name: status.dockerDesktopInstalled
      ? 'Docker Desktop'
      : 'Install Docker Desktop',
    description: status.dockerDesktopInstalled
      ? 'Official Docker product - already installed'
      : 'Official Docker product - will be downloaded and installed',
    value: 'docker-desktop',
  });

  return options;
}

// ============================================================================
// Component
// ============================================================================

export function DockerSetup({
  title = 'Docker Setup',
  onComplete,
  showBack = false,
  onBack,
}: DockerSetupProps) {
  const { theme } = useTheme();
  const [state, setState] = useState<SetupState>({ type: 'checking' });

  // Helper to start image building after Docker is ready
  const startImageBuild = useCallback(() => {
    setState({ type: 'building-image', message: 'Checking Docker image' });
  }, []);

  // Check Docker status on mount
  const statusPromise = useMemo(() => checkDockerStatus(), []);

  useEffect(() => {
    statusPromise
      .then((status) => {
        if (status.isRunning) {
          // Docker is already running - proceed to image building
          startImageBuild();
        } else if (status.orbstackInstalled && !status.dockerDesktopInstalled) {
          // Only OrbStack installed - start it automatically
          setState({
            type: 'starting',
            provider: 'orbstack',
            message: 'Starting OrbStack',
          });
        } else if (status.dockerDesktopInstalled && !status.orbstackInstalled) {
          // Only Docker Desktop installed - start it automatically
          setState({
            type: 'starting',
            provider: 'docker-desktop',
            message: 'Starting Docker Desktop',
          });
        } else {
          // Neither or both installed - show selection UI
          setState({ type: 'select-provider', status });
        }
      })
      .catch((err) => {
        setState({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [statusPromise, startImageBuild]);

  // Handle starting a provider
  const startingProvider = state.type === 'starting' ? state.provider : null;
  useEffect(() => {
    if (!startingProvider) return;

    startProvider(startingProvider, 600, (message) => {
      setState((s) => (s.type === 'starting' ? { ...s, message } : s));
    })
      .then(() => {
        // Docker is now running - proceed to image building
        startImageBuild();
      })
      .catch((err) => {
        setState({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [startingProvider, startImageBuild]);

  // Handle installing a provider
  const installingProvider =
    state.type === 'installing' ? state.provider : null;
  useEffect(() => {
    if (!installingProvider) return;

    installProvider(installingProvider)
      .then(() => {
        // After installation, start the provider
        setState({
          type: 'starting',
          provider: installingProvider,
          message: `Starting ${installingProvider === 'orbstack' ? 'OrbStack' : 'Docker Desktop'}`,
        });
      })
      .catch((err) => {
        setState({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [installingProvider]);

  // Track if we're currently building (to avoid restarting on state changes)
  const buildingRef = useRef(false);
  // Track if the component is unmounted (use ref so it persists across effect runs)
  const unmountedRef = useRef(false);

  // Handle building Docker image
  const isBuildingImage = state.type === 'building-image';
  useEffect(() => {
    if (!isBuildingImage) return;
    if (buildingRef.current) return; // Already building, don't restart

    buildingRef.current = true;
    unmountedRef.current = false;

    const handleProgress = (progress: ImageBuildProgress) => {
      switch (progress.type) {
        case 'checking':
          setState({
            type: 'building-image',
            message: 'Checking Docker image',
          });
          break;
        case 'exists':
          // Image already exists - we're done!
          buildingRef.current = false;
          setState({ type: 'ready' });
          if (!unmountedRef.current) {
            setTimeout(() => {
              onComplete({ type: 'ready' });
            }, 500);
          }
          break;
        case 'pulling':
        case 'pulling-cache':
        case 'building':
          setState({
            type: 'building-image',
            message: progress.message,
          });
          break;
        case 'done':
          buildingRef.current = false;
          setState({ type: 'ready' });
          if (!unmountedRef.current) {
            setTimeout(() => {
              onComplete({ type: 'ready' });
            }, 500);
          }
          break;
      }
    };

    ensureDockerImage({
      onProgress: handleProgress,
    }).catch((err) => {
      if (unmountedRef.current) return;
      buildingRef.current = false;
      setState({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });

    // No cleanup needed here - we handle unmount separately
  }, [isBuildingImage, onComplete]);

  // Separate effect for component unmount only
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const handleCancel = () => {
    onComplete({ type: 'cancelled' });
  };

  useKeyboard((key) => {
    if (key.name === 'escape') {
      handleCancel();
    }
  });

  // ---- Checking State ----
  if (state.type === 'checking') {
    return (
      <Loading
        title={title}
        message="Checking Docker status"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Ready State ----
  if (state.type === 'ready') {
    return (
      <box flexDirection="column" padding={1} flexGrow={1}>
        <box
          title={title}
          border
          borderStyle="single"
          padding={1}
          flexDirection="column"
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
        >
          <text fg={theme.success}>Docker is running!</text>
          <text fg={theme.textMuted} marginTop={1}>
            Press Esc to exit
          </text>
        </box>
      </box>
    );
  }

  // ---- Starting State ----
  if (state.type === 'starting') {
    const providerName =
      state.provider === 'orbstack' ? 'OrbStack' : 'Docker Desktop';
    return (
      <Loading
        title={title}
        message={state.message}
        detail={`This may take a minute while ${providerName} initializes`}
        onCancel={handleCancel}
      />
    );
  }

  // ---- Installing State ----
  if (state.type === 'installing') {
    const providerName =
      state.provider === 'orbstack' ? 'OrbStack' : 'Docker Desktop';
    return (
      <Loading
        title={title}
        message={`Installing ${providerName}`}
        detail="This may take a few minutes."
        onCancel={handleCancel}
      />
    );
  }

  // ---- Building Image State ----
  if (state.type === 'building-image') {
    return (
      <Loading
        title={title}
        message={state.message}
        detail="This may take a few minutes on first run"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Error State ----
  if (state.type === 'error') {
    return (
      <box flexDirection="column" padding={1} flexGrow={1}>
        <box
          title={title}
          border
          borderStyle="single"
          padding={1}
          flexDirection="column"
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
        >
          <text fg={theme.error}>Error: {state.message}</text>
          <text fg={theme.textMuted} marginTop={1}>
            Please install Docker manually and try again.
          </text>
          <text fg={theme.primary}>
            Visit: https://docs.docker.com/get-docker/
          </text>
          <text fg={theme.textMuted} marginTop={1}>
            Press Esc to exit
          </text>
        </box>
      </box>
    );
  }

  // ---- Select Provider State ----
  const { status } = state;
  const options = getProviderOptions(status);

  const description =
    status.dockerDesktopInstalled || status.orbstackInstalled
      ? 'Docker is not running. Select a runtime to start:'
      : 'A Docker-compatible runtime is required. Select one to install:';

  return (
    <Selector
      title={title}
      description={description}
      options={options}
      initialIndex={0}
      showBack={showBack}
      onSelect={(value) => {
        const provider = value as DockerProvider;
        const isInstalled =
          provider === 'orbstack'
            ? status.orbstackInstalled
            : status.dockerDesktopInstalled;

        if (isInstalled) {
          // Provider is installed, just start it
          setState({
            type: 'starting',
            provider,
            message: `Starting ${provider === 'orbstack' ? 'OrbStack' : 'Docker Desktop'}`,
          });
        } else {
          // Provider needs to be installed first
          setState({ type: 'installing', provider });
        }
      }}
      onCancel={handleCancel}
      onBack={onBack}
    />
  );
}

/**
 * Run the Docker setup screen as a standalone TUI.
 * This is used by commands like `branch` that need to ensure Docker is ready
 * but aren't part of a larger wizard flow.
 *
 * The TUI handles both Docker runtime setup and Docker image building.
 *
 * @returns Promise that resolves with the setup result
 */
export async function runDockerSetupScreen(): Promise<DockerSetupResult> {
  // Always show the TUI - it handles both Docker setup and image building
  // The DockerSetup component will skip straight to image building if Docker is already running
  let resolveSetup: (result: DockerSetupResult) => void;
  const setupPromise = new Promise<DockerSetupResult>((resolve) => {
    resolveSetup = resolve;
  });

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <DockerSetup
        title="Docker Setup"
        onComplete={(result) => resolveSetup(result)}
      />
    </CopyOnSelect>,
  );

  const result = await setupPromise;

  await destroy();

  return result;
}
