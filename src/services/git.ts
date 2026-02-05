// ============================================================================
// Git & Branch Name Services
// ============================================================================

import { nanoid } from 'nanoid';
import { formatShellError, type ShellError } from '../utils';
import { runClaudeInDocker } from './claude';
import type { AgentType } from './config';
import { log } from './logger';
import { runOpencodeInDocker } from './opencode';

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string; // owner/repo
}

/**
 * Parse a GitHub remote URL into owner/repo components.
 * Supports both HTTPS and SSH formats:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
export function parseGitHubUrl(remoteUrl: string): RepoInfo {
  let repoPath = remoteUrl;
  repoPath = repoPath.replace(/^https:\/\/github\.com\//, '');
  repoPath = repoPath.replace(/^git@github\.com:/, '');
  repoPath = repoPath.replace(/\.git$/, '');

  const parts = repoPath.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Unable to parse GitHub repository from remote URL: ${remoteUrl}`,
    );
  }

  return {
    owner: parts[0],
    repo: parts[1],
    fullName: repoPath,
  };
}

export async function getRepoInfo(): Promise<RepoInfo> {
  let remoteUrl: string;
  try {
    const result = await Bun.$`git remote get-url origin`.quiet();
    remoteUrl = result.stdout.toString().trim();
  } catch (err) {
    log.error({ err }, 'Failed to get git remote URL');
    throw formatShellError(err as ShellError);
  }

  return parseGitHubUrl(remoteUrl);
}

/**
 * Try to get repo info, returning null if not in a git repo or no valid remote.
 */
export async function tryGetRepoInfo(): Promise<RepoInfo | null> {
  try {
    return await getRepoInfo();
  } catch (err) {
    log.debug(
      { err },
      'Failed to get repo info (not in a git repo or no valid remote)',
    );
    return null;
  }
}

export function isValidBranchName(name: string): [boolean, string] {
  // Must start with letter, contain only lowercase letters, numbers, hyphens
  // Must end with letter or number, max 50 chars
  if (!name || name.length < 5) {
    return [false, 'too short'];
  }
  if (name.length > 50) {
    return [false, 'too long'];
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
    return [false, 'invalid characters'];
  }
  if (name.includes('--')) {
    return [false, 'double hyphens not allowed'];
  }
  return [true, ''];
}

async function getExistingBranches(): Promise<string[]> {
  try {
    const result = await Bun.$`git branch --list`.quiet();
    return result.stdout
      .toString()
      .split('\n')
      .map((line) => line.replace(/^\*?\s*/, '').trim())
      .filter(Boolean);
  } catch (err) {
    log.debug(
      { err },
      'Failed to get existing git branches (not in a git repo)',
    );
    // Not in a git repo or git not available, return empty array
    return [];
  }
}

async function getExistingServices(): Promise<string[]> {
  try {
    const result = await Bun.$`tiger svc list -o json`.quiet();
    const services = JSON.parse(result.stdout.toString());
    return services.map((svc: { name: string }) => svc.name);
  } catch (err) {
    log.error({ err }, 'Failed to get existing services');
    // tiger CLI not available or no services, return empty array
    return [];
  }
}

async function getExistingContainers(): Promise<string[]> {
  try {
    // Get all container names (running and stopped), strip "hermes-" prefix if present
    const result = await Bun.$`docker ps -a --format {{.Names}}`.quiet();
    return result.stdout
      .toString()
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.replace(/^hermes-/, '')); // Normalize to branch name format
  } catch (error) {
    log.error({ error }, 'Failed to get existing Docker containers');
    // Docker not available, return empty array
    return [];
  }
}

export interface GenerateBranchNameOptions {
  prompt: string;
  agent?: AgentType;
  model?: string;
  onProgress?: (message: string) => void;
  maxRetries?: number;
}

export async function generateBranchName({
  prompt,
  agent = 'claude',
  model,
  onProgress,
  maxRetries = 3,
}: GenerateBranchNameOptions): Promise<string> {
  // Gather all existing names to avoid conflicts
  const [existingBranches, existingServices, existingContainers] =
    await Promise.all([
      getExistingBranches(),
      getExistingServices(),
      getExistingContainers(),
    ]);

  const allExistingNames = new Set([
    ...existingBranches,
    ...existingServices,
    ...existingContainers,
  ]);

  let lastAttempt = '';

  // Determine effective model - use fastest model for branch name generation if not specified
  const effectiveModel = model ?? (agent === 'claude' ? 'haiku' : undefined);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let llmPrompt = `Generate a git branch name for the following task:

<task>
\`\`\`markdown
${prompt.replace(/```/g, '\\`\\`\\`')}
\`\`\`
</task>

Requirements:
- Lowercase letters, numbers, and hyphens only
- No special characters, spaces, or underscores
- Keep it concise (2-4 words max)
- Example format: add-user-auth, fix-login-bug

CRITICAL: Output ONLY the branch name, nothing else`;

    if (allExistingNames.size > 0) {
      llmPrompt += `\n\nIMPORTANT: Do NOT use any of these names (they already exist):
${[...allExistingNames].join(', ')}`;
    }

    if (lastAttempt) {
      llmPrompt += `\n\nThe name '${lastAttempt}' is invalid. Suggest a different name.`;
    }

    let result: string;
    try {
      if (agent === 'claude') {
        const cmdArgs = effectiveModel
          ? ['--model', effectiveModel, '-p', llmPrompt]
          : ['-p', llmPrompt];
        const proc = await runClaudeInDocker({ cmdArgs });
        result = proc.text();
      } else {
        // opencode
        const cmdArgs = effectiveModel
          ? ['run', '--model', effectiveModel, llmPrompt]
          : ['run', llmPrompt];
        const proc = await runOpencodeInDocker({ cmdArgs });
        result = proc.text();
      }
    } catch (err) {
      log.error({ err, agent }, 'Failed to generate branch name');
      onProgress?.(`Failed to generate branch name with ${agent}`);
      break;
    }
    const branchName = result.trim().toLowerCase();

    // Clean up any quotes or extra whitespace
    const cleaned = branchName.replace(/['"\n ]/g, '').trim();

    const [isValid, reason] = isValidBranchName(cleaned);
    if (!isValid) {
      onProgress?.(`Attempt ${attempt} is invalid (${reason})`);
      lastAttempt = cleaned.slice(0, 100);
      continue;
    }

    if (allExistingNames.has(cleaned)) {
      onProgress?.(`Attempt ${attempt}: '${cleaned}' already exists`);
      lastAttempt = cleaned;
      allExistingNames.add(cleaned); // Add to set to avoid suggesting again
      continue;
    }

    return cleaned;
  }

  onProgress?.('Failed to generate a valid branch name, using a random name.');
  // Fallback: use a generic name with random suffix
  let fallbackName: string;
  do {
    const randomSuffix = nanoid(12).toLowerCase();
    fallbackName = `hermes-branch-${randomSuffix}`;
  } while (allExistingNames.has(fallbackName));
  return fallbackName;
}
