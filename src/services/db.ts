// ============================================================================
// Database Fork Service
// ============================================================================

import { raceAbort, throwIfAborted } from '../utils/abort.ts';
import { formatShellError, type ShellError } from '../utils/shell.ts';
import type { DbServiceProvider } from './config';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { runGhostInDocker } from './ghost';
import { log } from './logger';

export interface ForkResult {
  service_id: string;
  name: string;
  envVars: Record<string, string>; // PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
  pgpassContent?: string;
}

export function parseEnvOutput(output: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.substring(0, eqIndex);
    const value = trimmed.substring(eqIndex + 1);
    envVars[key] = value;
  }
  return envVars;
}

/**
 * Parse a PostgreSQL connection string into individual PG env vars.
 * Handles `postgresql://user:pass@host:port/db` format.
 */
export function parseConnectionString(connStr: string): Record<string, string> {
  const url = new URL(connStr);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

// ============================================================================
// Tiger Fork
// ============================================================================

async function forkDatabaseTiger(
  branchName: string,
  serviceId?: string | null,
  signal?: AbortSignal,
): Promise<ForkResult> {
  const baseArgs = serviceId ? [serviceId] : [];
  const forkArgs = ['--now', '--name', branchName, '--with-password'];

  // Fork and get JSON output for metadata (service_id, name)
  throwIfAborted(signal);
  let jsonOutput: string;
  try {
    const forkProc = Bun.spawn(
      ['tiger', 'svc', 'fork', ...baseArgs, ...forkArgs, '-o', 'json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    // Use raceAbort to unblock on abort even if the process doesn't exit quickly
    // after being killed. The process is killed when the signal aborts.
    if (signal) {
      signal.addEventListener('abort', () => forkProc.kill(), { once: true });
    }
    await raceAbort(signal, forkProc.exited);
    if (forkProc.exitCode !== 0) {
      const stderr = await new Response(forkProc.stderr).text();
      throw Object.assign(new Error('tiger svc fork failed'), {
        exitCode: forkProc.exitCode,
        stderr,
      });
    }
    jsonOutput = await new Response(forkProc.stdout).text();
  } catch (err) {
    log.error({ err }, 'Failed to fork database');
    throw formatShellError(err as ShellError);
  }
  const metadata = JSON.parse(jsonOutput);

  // Get env output for the PG* variables using the new service's ID
  throwIfAborted(signal);
  let envOutput: string;
  try {
    const getProc = Bun.spawn(
      [
        'tiger',
        'svc',
        'get',
        metadata.service_id,
        '-o',
        'env',
        '--with-password',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    // Use raceAbort to unblock on abort even if the process doesn't exit quickly
    // after being killed. The process is killed when the signal aborts.
    if (signal) {
      signal.addEventListener('abort', () => getProc.kill(), { once: true });
    }
    await raceAbort(signal, getProc.exited);
    if (getProc.exitCode !== 0) {
      const stderr = await new Response(getProc.stderr).text();
      throw Object.assign(new Error('tiger svc get failed'), {
        exitCode: getProc.exitCode,
        stderr,
      });
    }
    envOutput = await new Response(getProc.stdout).text();
  } catch (err) {
    log.error(
      { err },
      'Failed to get environment variables for forked database',
    );
    throw formatShellError(err as ShellError);
  }
  const envVars = parseEnvOutput(envOutput);

  return {
    service_id: metadata.service_id,
    name: metadata.name,
    envVars,
  };
}

// ============================================================================
// Ghost Fork
// ============================================================================

async function forkDatabaseGhost(
  branchName: string,
  serviceId?: string | null,
  signal?: AbortSignal,
): Promise<ForkResult> {
  if (!serviceId) {
    throw new Error('Ghost fork requires a service ID (dbServiceId)');
  }

  // Step 1: Fork the database
  throwIfAborted(signal);
  log.info({ serviceId, branchName }, 'Creating Ghost database fork');
  const forkProc = await runGhostInDocker({
    cmdArgs: ['fork', serviceId, '--name', branchName, '--json'],
    shouldThrow: true,
    quiet: true,
    signal,
    removeContainerOnExit: false,
  });

  try {
    await forkProc.exited;
    const forkOutput = forkProc.text().trim();
    log.debug({ forkOutput }, 'Ghost fork output');
    const forkMetadata = JSON.parse(forkOutput);

    const forkId: string = forkMetadata.id;
    const forkName: string = forkMetadata.name ?? branchName;

    // Step 2: Get the connection string
    throwIfAborted(signal);
    log.info({ forkId }, 'Getting Ghost fork connection string');
    const connectProc = await runGhostInDocker({
      cmdArgs: ['connect', forkId],
      shouldThrow: true,
      quiet: true,
      signal,
    });
    await connectProc.exited;
    const connectionString = connectProc.text().trim();
    log.debug('Ghost connect output received');

    // Step 3: Parse connection string into PG env vars
    const envVars = parseConnectionString(connectionString);
    envVars.DATABASE_URL = connectionString;

    // Step 4: Try to capture .pgpass from the fork container
    let pgpassContent: string | undefined;
    try {
      const { containerId } = forkProc;
      if (containerId) {
        pgpassContent = await readFileFromContainer(
          containerId,
          `${CONTAINER_HOME}/.pgpass`,
        );
      }
    } catch {
      log.debug(
        'Could not capture .pgpass from Ghost container (non-critical)',
      );
    }

    return {
      service_id: forkId,
      name: forkName,
      envVars,
      pgpassContent,
    };
  } finally {
    await forkProc.rm(false).catch(() => {
      log.debug('Failed to remove Ghost fork container during cleanup');
    });
  }
}

// ============================================================================
// Dispatch
// ============================================================================

export async function forkDatabase(
  branchName: string,
  serviceId?: string | null,
  signal?: AbortSignal,
  provider?: DbServiceProvider | null,
): Promise<ForkResult> {
  switch (provider) {
    case 'ghost':
      return forkDatabaseGhost(branchName, serviceId, signal);
    default:
      return forkDatabaseTiger(branchName, serviceId, signal);
  }
}
