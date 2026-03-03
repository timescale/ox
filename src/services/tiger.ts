// ============================================================================
// Tiger Service - Interact with tiger CLI
// ============================================================================

import { formatShellError, type ShellError } from '../utils/shell.ts';
import { log } from './logger';

export interface TigerService {
  service_id: string;
  name: string;
  status: string;
  region_code: string;
  metadata: {
    environment: string; // "DEV" | "PROD"
  };
  host: string;
  port: number;
  database: string;
  paused: boolean;
  created: string;
}

/**
 * List all Tiger services available to the current user
 */
export async function listServices(): Promise<TigerService[]> {
  try {
    const result = await Bun.$`tiger svc list -o json`.quiet();
    return JSON.parse(result.stdout.toString());
  } catch (err) {
    log.error({ err }, 'Failed to list Tiger services');
    // Check if tiger CLI is not installed
    const error = err as ShellError;
    if (error.exitCode === 127 || error.message?.includes('not found')) {
      throw new Error(
        'Tiger CLI is not installed. Please install it first:\n' +
          '  curl -fsSL https://cli.tigerdata.com | sh',
      );
    }
    throw formatShellError(error);
  }
}

/**
 * Check if the tiger CLI is available
 */
export async function isTigerAvailable(): Promise<boolean> {
  try {
    await Bun.$`tiger version`.quiet();
    return true;
  } catch {
    return false;
  }
}
