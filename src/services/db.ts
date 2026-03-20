// ============================================================================
// Database Fork Service
// ============================================================================

import { onAbort, throwIfAborted } from '../utils/abort.ts';
import { formatShellError, type ShellError } from '../utils/shell.ts';
import { log } from './logger';

export interface ForkResult {
  service_id: string;
  name: string;
  envVars: Record<string, string>; // PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
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

export async function forkDatabase(
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
    const cleanupFork = onAbort(signal, () => forkProc.kill());
    try {
      await forkProc.exited;
      throwIfAborted(signal);
      if (forkProc.exitCode !== 0) {
        const stderr = await new Response(forkProc.stderr).text();
        throw Object.assign(new Error('tiger svc fork failed'), {
          exitCode: forkProc.exitCode,
          stderr,
        });
      }
      jsonOutput = await new Response(forkProc.stdout).text();
    } finally {
      cleanupFork();
    }
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
    const cleanupGet = onAbort(signal, () => getProc.kill());
    try {
      await getProc.exited;
      throwIfAborted(signal);
      if (getProc.exitCode !== 0) {
        const stderr = await new Response(getProc.stderr).text();
        throw Object.assign(new Error('tiger svc get failed'), {
          exitCode: getProc.exitCode,
          stderr,
        });
      }
      envOutput = await new Response(getProc.stdout).text();
    } finally {
      cleanupGet();
    }
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
