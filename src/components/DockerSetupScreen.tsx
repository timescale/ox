// ============================================================================
// Docker Setup Screen - Standalone screen runner for Docker setup
// ============================================================================

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { DockerSetup, type DockerSetupResult } from './DockerSetup';

/**
 * Run the Docker setup screen as a standalone TUI.
 * This is used by commands like `branch` that need to ensure Docker is ready
 * but aren't part of a larger wizard flow.
 *
 * @returns Promise that resolves with the setup result
 */
export async function runDockerSetupScreen(): Promise<DockerSetupResult> {
  let resolveSetup: (result: DockerSetupResult) => void;
  const setupPromise = new Promise<DockerSetupResult>((resolve) => {
    resolveSetup = resolve;
  });

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(
    <DockerSetup
      title="Docker Setup"
      onComplete={(result) => resolveSetup(result)}
    />,
  );

  const result = await setupPromise;

  await renderer.idle();
  renderer.destroy();

  return result;
}
