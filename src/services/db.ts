// ============================================================================
// Database Fork Service
// ============================================================================

import { formatShellError, type ShellError } from '../utils';

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
): Promise<ForkResult> {
  const baseArgs = serviceId ? [serviceId] : [];
  const forkArgs = ['--now', '--name', branchName, '--with-password'];

  // Fork and get JSON output for metadata (service_id, name)
  let jsonOutput: string;
  try {
    const proc =
      await Bun.$`tiger svc fork ${baseArgs} ${forkArgs} -o json`.quiet();
    jsonOutput = proc.stdout.toString();
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
  const metadata = JSON.parse(jsonOutput);

  // Get env output for the PG* variables using the new service's ID
  let envOutput: string;
  try {
    const proc =
      await Bun.$`tiger svc get ${metadata.service_id} -o env --with-password`.quiet();
    envOutput = proc.stdout.toString();
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
  const envVars = parseEnvOutput(envOutput);

  return {
    service_id: metadata.service_id,
    name: metadata.name,
    envVars,
  };
}
