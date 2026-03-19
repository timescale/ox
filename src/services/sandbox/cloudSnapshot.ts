// ============================================================================
// Cloud Snapshot Management - Base + agent overlay snapshots for cloud sandboxes
// ============================================================================

import { BuildError } from '../buildError.ts';
import type { AgentType, OxConfig } from '../config.ts';
import {
  computeProjectSetupHash,
  getAgentInstallScript,
  getAgentVersion,
} from '../docker.ts';
import { log } from '../logger.ts';
import { computeCloudBaseHash, getCloudBaseSteps } from './cloudBaseSteps.ts';
import { DenoApiClient, denoSlug, type ResolvedSandbox } from './denoApi.ts';
import { sandboxExec } from './sandboxExec.ts';

export type SnapshotBuildProgress =
  | { type: 'checking' }
  | { type: 'exists'; snapshotSlug: string }
  | { type: 'creating-volume'; message: string }
  | { type: 'booting-sandbox'; message: string }
  | { type: 'installing'; message: string; detail?: string }
  | { type: 'snapshotting'; message: string }
  | { type: 'cleaning-up'; message: string }
  | { type: 'done'; snapshotSlug: string }
  | { type: 'error'; message: string };

export function getBaseSnapshotSlug(
  config: Pick<OxConfig, 'dockerInSandbox'> = {},
): string {
  // Content-hash based: slug only changes when base build steps change.
  // Format: ox-base-{12-char-hash}, truncated to 32 chars.
  const hash = computeCloudBaseHash(config);
  return `ox-base-${hash}`.slice(0, 32).replace(/-+$/, '');
}

/**
 * Get the deterministic snapshot slug for a project setup layer.
 * Encodes the base hash and setup script content.
 * Constrained to 32 characters (Deno slug limit).
 */
export function getProjectSetupSnapshotSlug(
  baseHash: string,
  script: string,
): string {
  const setupHash = computeProjectSetupHash(baseHash, script);
  return `oxl-${setupHash}`.slice(0, 32).replace(/-+$/, '');
}

/**
 * Get the deterministic snapshot slug for an agent overlay.
 * Encodes the effective base version (setup layer or base), agent name, and agent version.
 * Constrained to 32 characters (Deno slug limit).
 *
 * @param agent - The agent type
 * @param setupHash - If a project setup layer is active, the setup hash to use
 *   instead of the base hash. This ensures the agent overlay rebuilds when
 *   the setup layer changes.
 */
export function getAgentSnapshotSlug(
  agent: AgentType,
  setupHash?: string,
  config: Pick<OxConfig, 'dockerInSandbox'> = {},
): string {
  const hash = (setupHash ?? computeCloudBaseHash(config)).slice(0, 6);
  const agentVer = getAgentVersion(agent)
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 6);
  // e.g. "ox-a1b2c3-claude-2-1-72" — fit within 32 chars
  return `ox-${hash}-${agent}-${agentVer}`.slice(0, 32).replace(/-+$/, '');
}

/**
 * Check if a snapshot is bootable via the Console API.
 * Returns true only if the snapshot exists AND is bootable.
 */
async function isSnapshotBootable(
  token: string,
  snapshotSlug: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://console.deno.com/api/v2/snapshots?search=${encodeURIComponent(snapshotSlug)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return false;
    const items = (await resp.json()) as Array<{
      slug: string;
      is_bootable: boolean;
    }>;
    const match = items.find((s) => s.slug === snapshotSlug);
    return match?.is_bootable === true;
  } catch {
    return false;
  }
}

/**
 * Ensure the base cloud snapshot exists for the current ox version.
 * Creates it if it doesn't exist by:
 * 1. Creating a bootable volume from `builtin:debian-13`
 * 2. Booting a sandbox directly from that volume
 * 3. Installing all required tools
 * 4. Killing the sandbox to detach the volume
 * 5. Snapshotting the volume
 *
 * The volume MUST be created from a bootable base image. An empty
 * volume (even with files rsync'd into it) is NOT bootable.
 */
export async function ensureCloudSnapshot(options: {
  token: string;
  region: string;
  config?: Pick<OxConfig, 'dockerInSandbox'>;
  force?: boolean;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, config = {}, force, onProgress } = options;
  const client = new DenoApiClient(token);
  const snapshotSlug = getBaseSnapshotSlug(config);

  // 1. Check if snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  if (force) {
    // Force rebuild: delete existing snapshot if present
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        log.info({ snapshotSlug }, 'Force rebuild: deleting existing snapshot');
        await client.deleteSnapshot(existing.id);
      }
    } catch {
      // Snapshot doesn't exist, nothing to delete
    }
  } else {
    // Normal flow: check if snapshot already exists AND is bootable
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        const bootable = await isSnapshotBootable(token, snapshotSlug);
        if (bootable) {
          onProgress?.({ type: 'exists', snapshotSlug });
          return snapshotSlug;
        }
        log.warn(
          { snapshotSlug },
          'Snapshot exists but is not bootable — deleting and rebuilding',
        );
        try {
          await client.deleteSnapshot(existing.id);
        } catch (err) {
          log.debug({ err }, 'Failed to delete non-bootable snapshot');
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to check snapshot');
    }
  }

  // 2. Create a bootable volume from the Debian base image
  const buildVolumeSlug = denoSlug('oxb');
  onProgress?.({
    type: 'creating-volume',
    message: 'Creating bootable build volume',
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: 'builtin:debian-13',
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox directly from the volume (it's bootable!)
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting build sandbox from volume',
    });

    try {
      sandbox = await client.createSandbox({
        region: region as 'ord' | 'ams',
        root: volume.slug,
        timeout: '30m',
        memory: '2GiB',
      });
    } catch (err) {
      log.error({ err, region }, 'Failed to create build sandbox');
      throw err;
    }
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug({ sandboxId: buildSandboxId }, 'Build sandbox created');

    // 4. Execute all base build steps
    for (const step of getCloudBaseSteps(config)) {
      onProgress?.({
        type: 'installing',
        message: step.message,
        detail: step.detail,
      });
      await sandboxExec(sandbox, step.command, {
        label: step.label,
        sudo: step.sudo,
      });
    }

    // Kill sandbox and wait for volume detachment (required before snapshotting)
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping build sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      await client.killAndWaitForDetach(buildSandboxId);
    } else {
      log.warn(
        'No sandbox ID available — cannot kill build sandbox. It may need manual cleanup.',
      );
    }
    sandbox = null; // Prevent double-kill in finally

    // 12. Snapshot the volume (retries on VOLUME_IS_MOUNTED — the platform
    //     may take time to fully release the volume after sandbox death)
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating snapshot (this may take a moment)',
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot build volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    // Only emit cleaning-up progress if we actually need to clean up
    // (i.e., the snapshot wasn't successfully created). On the success path,
    // 'done' has already been emitted — showing 'cleaning-up' after would
    // cause the UI to briefly flash "Cleaning up" after completion.
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up build resources',
      });
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore close errors
      }
      if (buildSandboxId) {
        try {
          await client.killSandbox(buildSandboxId);
        } catch (err) {
          log.debug({ err }, 'Failed to kill build sandbox in cleanup');
        }
      }
    }
    // Only delete the build volume if the snapshot was NOT created.
    // Deleting the volume while the platform is still processing the
    // snapshot kills the snapshot job (observed as JOB_IS_DEAD / 500).
    // On success, leave the volume — it can be cleaned up manually or
    // via `ox sessions clean`.
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}

/**
 * Ensure a project-specific setup layer cloud snapshot exists.
 *
 * Boots a sandbox from the base snapshot, executes the project setup script,
 * kills the sandbox, and snapshots the resulting volume.
 *
 * @returns The project setup snapshot slug (to be used as base for agent overlay)
 */
export async function ensureProjectSetupCloudSnapshot(options: {
  token: string;
  region: string;
  baseSnapshotSlug: string;
  script: string;
  force?: boolean;
  /** Stream the setup script's output to the terminal */
  stream?: boolean;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, baseSnapshotSlug, script, force, onProgress } =
    options;
  const client = new DenoApiClient(token);

  // Derive the base hash from the base snapshot slug (ox-base-{hash} -> {hash})
  const baseHash = baseSnapshotSlug.replace('ox-base-', '');
  const snapshotSlug = getProjectSetupSnapshotSlug(baseHash, script);

  // 1. Check if setup snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  if (force) {
    // Force rebuild: delete existing snapshot if present
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        log.info(
          { snapshotSlug },
          'Force rebuild: deleting existing project setup snapshot',
        );
        await client.deleteSnapshot(existing.id);
      }
    } catch {
      // Snapshot doesn't exist, nothing to delete
    }
  } else {
    // Normal flow: check if setup snapshot already exists AND is bootable
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        const bootable = await isSnapshotBootable(token, snapshotSlug);
        if (bootable) {
          onProgress?.({ type: 'exists', snapshotSlug });
          return snapshotSlug;
        }
        log.warn(
          { snapshotSlug },
          'Project setup snapshot exists but is not bootable — deleting and rebuilding',
        );
        try {
          await client.deleteSnapshot(existing.id);
        } catch (err) {
          log.debug(
            { err },
            'Failed to delete non-bootable project setup snapshot',
          );
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to check project setup snapshot');
    }
  }

  // 2. Create a bootable volume from the base snapshot
  const buildVolumeSlug = denoSlug('oxlb');
  onProgress?.({
    type: 'creating-volume',
    message: 'Creating volume for project setup layer',
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: baseSnapshotSlug,
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox from the base volume
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting sandbox for project setup',
    });

    sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug(
      { sandboxId: buildSandboxId },
      'Project setup build sandbox created',
    );

    // 4. Execute the project setup script
    //    Accumulate output lines so they can be included in errors.
    onProgress?.({
      type: 'installing',
      message: 'Running project setup script',
    });
    const outputLines: string[] = [];
    try {
      await sandboxExec(
        sandbox,
        `cat > /tmp/project-setup.sh << 'SETUP_EOF'\n${script}\nSETUP_EOF\nbash /tmp/project-setup.sh`,
        {
          label: 'Project setup',
          sudo: true,
          stream: options.stream,
          // Only send line-by-line progress when not streaming to terminal
          // (streaming already shows raw output)
          onLine: options.stream
            ? undefined
            : (line) => {
                outputLines.push(line);
                onProgress?.({
                  type: 'installing',
                  message: 'Running project setup script',
                  detail: line,
                });
              },
        },
      );
    } catch (err) {
      throw new BuildError(
        err instanceof Error ? err.message : String(err),
        outputLines,
      );
    }

    // Clean up temp files
    await sandboxExec(sandbox, 'rm -f /tmp/project-setup.sh', {
      label: 'Clean up project setup script',
      sudo: true,
    });

    // 5. Kill sandbox and wait for volume detachment
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping project setup sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      await client.killAndWaitForDetach(buildSandboxId);
    }
    sandbox = null;

    // 6. Snapshot the volume
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating project setup snapshot',
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot project setup volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up project setup build resources',
      });
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore close errors
      }
      if (buildSandboxId) {
        try {
          await client.killSandbox(buildSandboxId);
        } catch (err) {
          log.debug({ err }, 'Failed to kill project setup sandbox in cleanup');
        }
      }
    }
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete project setup build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving project setup build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}

/**
 * Ensure an agent-specific overlay cloud snapshot exists.
 *
 * Boots a sandbox from the base snapshot, installs the agent + tiger CLI,
 * kills the sandbox, and snapshots the resulting volume.
 *
 * Returns the agent overlay snapshot slug.
 */
export async function ensureAgentCloudSnapshot(options: {
  token: string;
  region: string;
  agent: AgentType;
  baseSnapshotSlug: string;
  /** If a project setup layer is active, its hash. Ensures the agent overlay
   *  slug changes when the setup layer changes, triggering a rebuild. */
  setupHash?: string;
  config?: Pick<OxConfig, 'dockerInSandbox'>;
  force?: boolean;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const {
    token,
    region,
    agent,
    baseSnapshotSlug,
    config = {},
    force,
    onProgress,
  } = options;
  const client = new DenoApiClient(token);
  const snapshotSlug = getAgentSnapshotSlug(agent, options.setupHash, config);

  // 1. Check if agent overlay snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  if (force) {
    // Force rebuild: delete existing snapshot if present
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        log.info(
          { snapshotSlug },
          'Force rebuild: deleting existing agent snapshot',
        );
        await client.deleteSnapshot(existing.id);
      }
    } catch {
      // Snapshot doesn't exist, nothing to delete
    }
  } else {
    // Normal flow: check if agent overlay snapshot already exists AND is bootable
    try {
      const existing = await client.getSnapshot(snapshotSlug);
      if (existing) {
        const bootable = await isSnapshotBootable(token, snapshotSlug);
        if (bootable) {
          onProgress?.({ type: 'exists', snapshotSlug });
          return snapshotSlug;
        }
        log.warn(
          { snapshotSlug },
          'Agent snapshot exists but is not bootable — deleting and rebuilding',
        );
        try {
          await client.deleteSnapshot(existing.id);
        } catch (err) {
          log.debug({ err }, 'Failed to delete non-bootable agent snapshot');
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to check agent snapshot');
    }
  }

  // 2. Create a bootable volume from the base snapshot
  const buildVolumeSlug = denoSlug('oxa');
  onProgress?.({
    type: 'creating-volume',
    message: `Creating volume for ${agent} agent`,
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: baseSnapshotSlug,
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox from the base volume
    onProgress?.({
      type: 'booting-sandbox',
      message: `Booting sandbox to install ${agent}`,
    });

    sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug(
      { sandboxId: buildSandboxId, agent },
      'Agent overlay build sandbox created',
    );

    // 4. Install the agent
    const agentVersion = getAgentVersion(agent);
    onProgress?.({
      type: 'installing',
      message: `Installing ${agent} v${agentVersion}`,
      detail: 'This may take a minute',
    });

    // Write the install script into a temp file and execute it
    const agentScript = getAgentInstallScript(agent);
    await sandboxExec(
      sandbox,
      `cat > /tmp/install-agent.sh << 'INSTALL_EOF'\n${agentScript}\nINSTALL_EOF\nbash /tmp/install-agent.sh ${agentVersion}`,
      { label: `Install ${agent}` },
    );

    // 5. Install Tiger CLI
    onProgress?.({
      type: 'installing',
      message: 'Installing Tiger CLI',
    });
    const tigerScript = getAgentInstallScript('tiger');
    await sandboxExec(
      sandbox,
      `cat > /tmp/install-tiger.sh << 'INSTALL_EOF'\n${tigerScript}\nINSTALL_EOF\nbash /tmp/install-tiger.sh`,
      { label: 'Install Tiger CLI' },
    );

    // 6. Add agent-specific bin dirs to PATH
    // The base already has ~/.local/bin. Agents like opencode install to
    // ~/.opencode/bin, codex installs to ~/.local/bin (already covered).
    if (agent === 'opencode') {
      await sandboxExec(
        sandbox,
        `printf 'export PATH="$HOME/.opencode/bin:$PATH"\\n' | sudo tee -a /etc/profile.d/ox-path.sh > /dev/null`,
        { label: 'Add opencode bin to PATH' },
      );
      await sandboxExec(
        sandbox,
        `printf 'export PATH="$HOME/.opencode/bin:$PATH"\\n' >> ~/.bashrc`,
        { label: 'Add opencode bin to bashrc' },
      );
    }

    // Clean up temp files
    await sandboxExec(
      sandbox,
      'rm -f /tmp/install-agent.sh /tmp/install-tiger.sh',
      {
        label: 'Clean up temp install scripts',
      },
    );

    // 7. Kill sandbox and wait for volume detachment
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping agent build sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      await client.killAndWaitForDetach(buildSandboxId);
    }
    sandbox = null;

    // 8. Snapshot the volume (retries on VOLUME_IS_MOUNTED)
    onProgress?.({
      type: 'snapshotting',
      message: `Creating ${agent} agent snapshot`,
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot agent build volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up agent build resources',
      });
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore close errors
      }
      if (buildSandboxId) {
        try {
          await client.killSandbox(buildSandboxId);
        } catch (err) {
          log.debug({ err }, 'Failed to kill agent build sandbox in cleanup');
        }
      }
    }
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete agent build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving agent build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}
