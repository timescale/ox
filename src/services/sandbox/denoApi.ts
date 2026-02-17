// ============================================================================
// Deno Deploy REST API Client
// ============================================================================

import { log } from '../logger.ts';

/**
 * Console API — management operations (list, create volumes/snapshots, etc.)
 * The official @deno/sandbox SDK uses this same base URL.
 */
const CONSOLE_API_BASE = 'https://console.deno.com/api/v2';

/**
 * Regional sandbox API — individual sandbox operations (exec, fs, ssh).
 * Each region has its own endpoint: {region}.sandbox-api.deno.net
 */
function sandboxApiBase(region: string): string {
  return `https://${region}.sandbox-api.deno.net/api/v3`;
}

export interface DenoSandbox {
  id: string;
  region: string;
  status: string;
  labels?: Record<string, string>;
  createdAt: string;
}

export interface DenoVolume {
  id: string;
  slug: string;
  region: string;
  capacity: string;
  createdAt: string;
}

export interface DenoSnapshot {
  id: string;
  slug: string;
  region: string;
  createdAt: string;
}

export interface CreateSandboxRequest {
  region: string;
  root?: string;
  timeout?: string;
  memory?: string;
  volumes?: Record<string, string>;
  labels?: Record<string, string>;
  env?: Record<string, string>;
}

export interface CreateVolumeRequest {
  slug: string;
  region: string;
  capacity?: string;
  from?: string;
}

export class DenoApiClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Make a request to the Deno Console API (management operations).
   */
  private async consoleRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${CONSOLE_API_BASE}${path}`;
    log.debug({ method, url }, 'Deno Console API request');

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `Network error connecting to Deno Deploy API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Deno API error ${response.status}: ${text}`);
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a request to the regional sandbox API (per-sandbox operations).
   */
  private async sandboxRequest<T>(
    method: string,
    region: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${sandboxApiBase(region)}${path}`;
    log.debug({ method, url }, 'Deno Sandbox API request');

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `Network error connecting to Deno Sandbox API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Deno Sandbox API error ${response.status}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // --------------------------------------------------------------------------
  // Sandbox Management (Console API)
  // --------------------------------------------------------------------------

  async listSandboxes(labels?: Record<string, string>): Promise<DenoSandbox[]> {
    let path = '/sandboxes';
    if (labels) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(labels)) {
        params.append(`label.${key}`, value);
      }
      path += `?${params.toString()}`;
    }
    return this.consoleRequest('GET', path);
  }

  async getSandbox(id: string): Promise<DenoSandbox> {
    return this.consoleRequest('GET', `/sandboxes/${id}`);
  }

  async createSandbox(req: CreateSandboxRequest): Promise<DenoSandbox> {
    return this.consoleRequest('POST', '/sandboxes', req);
  }

  async killSandbox(id: string): Promise<void> {
    return this.consoleRequest('DELETE', `/sandboxes/${id}`);
  }

  // --------------------------------------------------------------------------
  // Per-Sandbox Operations (Regional Sandbox API)
  // --------------------------------------------------------------------------

  async execInSandbox(
    id: string,
    region: string,
    command: string[],
    options?: { user?: string; workDir?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.sandboxRequest('POST', region, `/sandbox/${id}/exec`, {
      command,
      ...options,
    });
  }

  async writeFile(
    id: string,
    region: string,
    path: string,
    content: string,
    options?: { mode?: number; user?: string },
  ): Promise<void> {
    return this.sandboxRequest('POST', region, `/sandbox/${id}/fs/write`, {
      path,
      content,
      ...options,
    });
  }

  async readFile(id: string, region: string, path: string): Promise<string> {
    const result = await this.sandboxRequest<{ content: string }>(
      'POST',
      region,
      `/sandbox/${id}/fs/read`,
      { path },
    );
    return result.content;
  }

  async exposeSsh(
    id: string,
    region: string,
  ): Promise<{ hostname: string; username: string }> {
    return this.sandboxRequest('POST', region, `/sandbox/${id}/ssh/expose`);
  }

  // --------------------------------------------------------------------------
  // Volume Management (Console API)
  // --------------------------------------------------------------------------

  async createVolume(req: CreateVolumeRequest): Promise<DenoVolume> {
    return this.consoleRequest('POST', '/volumes', req);
  }

  async getVolume(id: string): Promise<DenoVolume> {
    return this.consoleRequest('GET', `/volumes/${id}`);
  }

  async listVolumes(): Promise<DenoVolume[]> {
    return this.consoleRequest('GET', '/volumes');
  }

  async deleteVolume(id: string): Promise<void> {
    return this.consoleRequest('DELETE', `/volumes/${id}`);
  }

  async snapshotVolume(volumeId: string, slug: string): Promise<DenoSnapshot> {
    return this.consoleRequest('POST', `/volumes/${volumeId}/snapshot`, {
      slug,
    });
  }

  // --------------------------------------------------------------------------
  // Snapshot Management (Console API)
  // --------------------------------------------------------------------------

  async listSnapshots(): Promise<DenoSnapshot[]> {
    return this.consoleRequest('GET', '/snapshots');
  }

  async getSnapshot(id: string): Promise<DenoSnapshot> {
    return this.consoleRequest('GET', `/snapshots/${id}`);
  }

  async deleteSnapshot(id: string): Promise<void> {
    return this.consoleRequest('DELETE', `/snapshots/${id}`);
  }
}
