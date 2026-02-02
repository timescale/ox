import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LazyTool = 'go' | 'docker' | 'ngrok';

export interface ToolMetadata {
  name: string;
  displayName: string;
  version: string;
  sizeEstimate: string;
}

// Note: These versions must match the installer script in sandbox/Dockerfile
export const LAZY_TOOLS: Record<LazyTool, ToolMetadata> = {
  go: {
    name: 'go',
    displayName: 'Go',
    version: '1.25.5',
    sizeEstimate: '~150MB',
  },
  docker: {
    name: 'docker',
    displayName: 'Docker + Compose',
    version: '27.4.1',
    sizeEstimate: '~300MB',
  },
  ngrok: {
    name: 'ngrok',
    displayName: 'ngrok',
    version: 'v3-stable',
    sizeEstimate: '~30MB',
  },
};

export const ALL_LAZY_TOOLS = Object.keys(LAZY_TOOLS) as LazyTool[];

// Tools directory on the host - shared across all projects
const TOOLS_HOST_DIR = join(homedir(), '.hermes', 'tools');
const TOOLS_CONTAINER_DIR = '/home/agent/.hermes-tools';
export const TOOLS_VOLUME_MOUNT = `${TOOLS_HOST_DIR}:${TOOLS_CONTAINER_DIR}`;

export const ensureToolsDirectory = async (): Promise<void> => {
  await mkdir(TOOLS_HOST_DIR, { recursive: true });
};

export const isToolInstalled = async (tool: LazyTool): Promise<boolean> => {
  const markerFile = Bun.file(join(TOOLS_HOST_DIR, tool, '.installed'));
  return markerFile.exists();
};

export const getInstalledTools = async (): Promise<LazyTool[]> => {
  const installed: LazyTool[] = [];
  for (const tool of ALL_LAZY_TOOLS) {
    if (await isToolInstalled(tool)) {
      installed.push(tool);
    }
  }
  return installed;
};

export const getMissingTools = async (): Promise<LazyTool[]> => {
  const missing: LazyTool[] = [];
  for (const tool of ALL_LAZY_TOOLS) {
    if (!(await isToolInstalled(tool))) {
      missing.push(tool);
    }
  }
  return missing;
};

export const getTotalSizeEstimate = (tools: LazyTool[]): string => {
  let totalMB = 0;
  for (const tool of tools) {
    const meta = LAZY_TOOLS[tool];
    const match = meta.sizeEstimate.match(/(\d+)/);
    if (match?.[1]) {
      totalMB += parseInt(match[1], 10);
    }
  }
  return `~${totalMB}MB`;
};
