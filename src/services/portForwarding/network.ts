import { $ } from 'bun';
import { log } from '../logger.ts';

/** Shared Docker bridge network for ox sandbox containers */
export const OX_NETWORK = 'ox-sandboxes';

/**
 * Ensure a Docker bridge network exists. Idempotent — no-ops if the network
 * already exists.
 */
export async function ensureNetwork(name: string = OX_NETWORK): Promise<void> {
  try {
    await $`docker network inspect ${name}`.quiet();
    log.debug({ network: name }, 'Docker network already exists');
  } catch {
    log.info({ network: name }, 'Creating Docker network');
    await $`docker network create ${name}`.quiet();
  }
}

/**
 * Connect a container to a Docker network. No-op if already connected.
 */
export async function connectToNetwork(
  containerName: string,
  network: string = OX_NETWORK,
): Promise<void> {
  try {
    await $`docker network connect ${network} ${containerName}`.quiet();
    log.debug({ containerName, network }, 'Connected container to network');
  } catch (err) {
    const msg = String(err);
    if (msg.includes('already exists') || msg.includes('is already')) {
      log.debug(
        { containerName, network },
        'Container already connected to network',
      );
      return;
    }
    throw err;
  }
}

/**
 * Disconnect a container from a Docker network. No-op if not connected.
 */
export async function disconnectFromNetwork(
  containerName: string,
  network: string = OX_NETWORK,
): Promise<void> {
  try {
    await $`docker network disconnect ${network} ${containerName}`.quiet();
    log.debug(
      { containerName, network },
      'Disconnected container from network',
    );
  } catch (err) {
    const msg = String(err);
    if (msg.includes('is not connected') || msg.includes('not found')) {
      log.debug(
        { containerName, network },
        'Container not connected to network',
      );
      return;
    }
    throw err;
  }
}
