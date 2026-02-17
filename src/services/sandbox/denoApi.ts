// ============================================================================
// Deno Deploy REST API Client
// ============================================================================

import { log } from '../logger.ts';

const API_BASE = 'https://api.deno.com/v1';

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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${API_BASE}${path}`;
    log.debug({ method, path }, 'Deno API request');

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

  // Organizations
  async listOrganizations(): Promise<{ id: string; name: string }[]> {
    return this.request('GET', '/organizations');
  }

  // Sandboxes
  async createSandbox(req: CreateSandboxRequest): Promise<DenoSandbox> {
    return this.request('POST', '/sandboxes', req);
  }

  async getSandbox(id: string): Promise<DenoSandbox> {
    return this.request('GET', `/sandboxes/${id}`);
  }

  async listSandboxes(labels?: Record<string, string>): Promise<DenoSandbox[]> {
    let path = '/sandboxes';
    if (labels) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(labels)) {
        params.append(`label.${key}`, value);
      }
      path += `?${params.toString()}`;
    }
    return this.request('GET', path);
  }

  async killSandbox(id: string): Promise<void> {
    return this.request('DELETE', `/sandboxes/${id}`);
  }

  async execInSandbox(
    id: string,
    command: string[],
    options?: { user?: string; workDir?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.request('POST', `/sandboxes/${id}/exec`, {
      command,
      ...options,
    });
  }

  async writeFile(
    id: string,
    path: string,
    content: string,
    options?: { mode?: number; user?: string },
  ): Promise<void> {
    return this.request('POST', `/sandboxes/${id}/fs/write`, {
      path,
      content,
      ...options,
    });
  }

  async readFile(id: string, path: string): Promise<string> {
    const result = await this.request<{ content: string }>(
      'POST',
      `/sandboxes/${id}/fs/read`,
      { path },
    );
    return result.content;
  }

  async exposeSsh(id: string): Promise<{ hostname: string; username: string }> {
    return this.request('POST', `/sandboxes/${id}/ssh/expose`);
  }

  // Volumes
  async createVolume(req: CreateVolumeRequest): Promise<DenoVolume> {
    return this.request('POST', '/volumes', req);
  }

  async getVolume(id: string): Promise<DenoVolume> {
    return this.request('GET', `/volumes/${id}`);
  }

  async listVolumes(): Promise<DenoVolume[]> {
    return this.request('GET', '/volumes');
  }

  async deleteVolume(id: string): Promise<void> {
    return this.request('DELETE', `/volumes/${id}`);
  }

  async snapshotVolume(volumeId: string, slug: string): Promise<DenoSnapshot> {
    return this.request('POST', `/volumes/${volumeId}/snapshot`, { slug });
  }

  // Snapshots
  async listSnapshots(): Promise<DenoSnapshot[]> {
    return this.request('GET', '/snapshots');
  }

  async getSnapshot(id: string): Promise<DenoSnapshot> {
    return this.request('GET', `/snapshots/${id}`);
  }

  async deleteSnapshot(id: string): Promise<void> {
    return this.request('DELETE', `/snapshots/${id}`);
  }
}
