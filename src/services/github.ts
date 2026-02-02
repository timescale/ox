// ============================================================================
// GitHub Service - PR operations via gh CLI in docker container
// ============================================================================

import { ghConfigVolume } from './auth';
import { log } from './logger';
import { runInDocker } from './runInDocker';

// ============================================================================
// Types
// ============================================================================

export interface PrInfo {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
}

interface GhPrListItem {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
}

// ============================================================================
// PR Fetching
// ============================================================================

/**
 * Get PR info for a branch by querying GitHub via gh CLI in docker.
 * Returns the most relevant PR (open first, then most recent).
 * Returns null if no PR exists or on any error.
 *
 * Note: Session branch names are stored without the 'hermes/' prefix,
 * so this function prepends it when querying GitHub.
 */
export async function getPrForBranch(
  repo: string,
  sessionName: string,
): Promise<PrInfo | null> {
  // Session branch names don't include the 'hermes/' prefix, but the actual
  // git branches are created with it (e.g., 'hermes/feature-xyz')
  const branch = sessionName.startsWith('hermes/')
    ? sessionName
    : `hermes/${sessionName}`;

  try {
    const result = await runInDocker({
      cmdName: 'gh',
      cmdArgs: [
        'pr',
        'list',
        '--head',
        branch,
        '--repo',
        repo,
        '--json',
        'number,state,url',
        '--limit',
        '10',
        '--state',
        'all',
      ],
      dockerArgs: ['--rm', '-v', ghConfigVolume()],
      shouldThrow: false,
    });

    const exitCode = await result.exited;
    if (exitCode !== 0) {
      log.debug(
        { repo, branch: branch, exitCode, stderr: result.errorText() },
        'gh pr list failed',
      );
      return null;
    }

    const text = result.text().trim();
    if (!text || text === '[]') {
      return null;
    }

    const prs = JSON.parse(text) as GhPrListItem[];
    if (!prs || prs.length === 0) {
      return null;
    }

    // Sort: OPEN first, then by highest PR number (most recent)
    prs.sort((a, b) => {
      // Open PRs come first
      if (a.state === 'OPEN' && b.state !== 'OPEN') return -1;
      if (b.state === 'OPEN' && a.state !== 'OPEN') return 1;
      // Then by PR number (higher = more recent)
      return b.number - a.number;
    });

    const pr = prs[0];
    if (!pr) {
      return null;
    }

    return {
      number: pr.number,
      state: pr.state,
      url: pr.url,
    };
  } catch (err) {
    log.debug({ err, repo, branch: branch }, 'Error fetching PR info');
    return null;
  }
}
