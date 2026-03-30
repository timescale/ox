// ============================================================================
// Database Fork Service
// ============================================================================

import type { SelectOption } from '@opentui/core';
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
    if (!trimmed.includes('=')) continue;
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

export function parseGhostPgpassLine(
  pgpassLine: string,
): Record<string, string> {
  // .pgpass fields are colon-separated. Passwords may contain colons,
  // so we split on the first 4 colons and treat the remainder as the password.
  const trimmed = pgpassLine.trim();
  const fields: string[] = [];
  let rest = trimmed;
  for (let i = 0; i < 4; i++) {
    const idx = rest.indexOf(':');
    if (idx === -1) {
      throw new Error('Invalid Ghost .pgpass line');
    }
    fields.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  const [PGHOST, PGPORT, PGDATABASE, PGUSER] = fields;
  const PGPASSWORD = rest; // everything after the 4th colon

  if (
    !PGHOST ||
    !PGPORT ||
    !PGDATABASE ||
    !PGUSER ||
    PGPASSWORD === undefined
  ) {
    throw new Error('Invalid Ghost .pgpass line');
  }

  return {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD,
    DATABASE_URL: `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`,
  };
}

export function getFirstUsablePgpassLine(pgpassContent: string): string | null {
  return (
    pgpassContent
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#')) ?? null
  );
}

export function ensureGhostCommandSucceeded({
  command,
  exitCode,
  output,
  errorOutput,
}: {
  command: string;
  exitCode: number;
  output: string;
  errorOutput: string;
}): string {
  if (exitCode === 0) {
    return output;
  }

  const detail = errorOutput.trim() || output.trim() || `exit code ${exitCode}`;
  throw new Error(`${command} failed: ${detail}`);
}

export async function deleteDatabaseFork(
  provider: DbServiceProvider,
  serviceId: string,
): Promise<void> {
  if (provider === 'ghost') {
    const proc = await runGhostInDocker({
      cmdArgs: ['delete', serviceId, '--confirm'],
      shouldThrow: false,
      quiet: true,
    });
    const exitCode = await proc.exited;
    ensureGhostCommandSucceeded({
      command: 'ghost delete',
      exitCode,
      output: proc.text(),
      errorOutput: proc.errorText(),
    });
    return;
  }

  try {
    await Bun.$`tiger svc delete ${serviceId} --confirm`.quiet();
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
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
    shouldThrow: false,
    quiet: true,
    signal,
    removeContainerOnExit: false,
  });

  try {
    const forkExitCode = await forkProc.exited;
    const forkOutput = ensureGhostCommandSucceeded({
      command: 'ghost fork',
      exitCode: forkExitCode,
      output: forkProc.text().trim(),
      errorOutput: forkProc.errorText().trim(),
    });
    log.debug({ forkOutput }, 'Ghost fork output');
    const forkMetadata = JSON.parse(forkOutput);

    const forkId: string = forkMetadata.id;
    const forkName: string = forkMetadata.name ?? branchName;

    // Step 2: Capture .pgpass from the fork container.
    // Wrap post-fork steps so we can clean up the cloud fork on failure.
    try {
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

      if (!pgpassContent) {
        throw new Error('Ghost fork did not produce .pgpass credentials');
      }

      // Step 3: Parse PG env vars directly from Ghost .pgpass
      const pgpassLine = getFirstUsablePgpassLine(pgpassContent);
      if (!pgpassLine) {
        throw new Error(
          'Ghost .pgpass did not contain any usable credential line',
        );
      }
      const envVars = parseGhostPgpassLine(pgpassLine);

      return {
        service_id: forkId,
        name: forkName,
        envVars,
        pgpassContent,
      };
    } catch (err) {
      // Clean up the orphaned cloud fork before re-throwing
      await deleteDatabaseFork('ghost', forkId).catch((cleanupErr) => {
        log.warn(
          { cleanupErr, forkId },
          'Failed to clean up orphaned Ghost fork',
        );
      });
      throw err;
    }
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
    case 'tiger':
    case undefined:
      return forkDatabaseTiger(branchName, serviceId, signal);
    default:
      // null means "explicitly no provider" — callers should guard against
      // this, but handle it defensively rather than silently forking Tiger.
      throw new Error(
        `Cannot fork database: no provider configured (got ${JSON.stringify(provider)})`,
      );
  }
}

export const dbProviderOptions: SelectOption[] = [
  {
    name: 'Ghost',
    description: 'ghost.build database service',
    value: 'ghost',
  },
  {
    name: 'Tiger Data',
    description: 'Tiger Cloud database service',
    value: 'tiger',
  },
  {
    name: '(None)',
    description: 'No database provider - skip database forks',
    value: '__null__',
  },
];
