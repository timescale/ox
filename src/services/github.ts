// ============================================================================
// GitHub Service - PR operations via gh CLI in docker container
// ============================================================================

import { $ } from 'bun';
import { nanoid } from 'nanoid';
import { formatShellError, type ShellError } from '../utils';
import { getGhConfigVolume, runGhInDocker } from './gh';
import { log } from './logger';

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
// PR Creation
// ============================================================================

/**
 * Push branch and create a PR from a stopped container.
 * Commits the container to a temp image, runs git push + gh pr create inside it.
 * This is the "ship it" action: push + PR in one shot.
 */
export async function pushAndCreatePr(
  containerId: string,
  repo: string,
  sessionName: string,
  diffStat?: string,
  commitLog?: string,
): Promise<PrInfo | null> {
  const branch = sessionName.startsWith('hermes/')
    ? sessionName
    : `hermes/${sessionName}`;

  // Build PR title and body from commit log
  const commits = (commitLog ?? '').split('\n').filter((l) => l.trim());
  const firstCommit = commits[0];
  const title = firstCommit
    ? firstCommit.replace(/^[a-f0-9]+\s+/, '') // strip hash prefix
    : `Changes from ${branch}`;

  const bodyParts = ['## Summary', ''];
  if (commits.length > 1) {
    for (const commit of commits) {
      bodyParts.push(`- ${commit}`);
    }
  } else if (firstCommit) {
    bodyParts.push(`- ${firstCommit}`);
  }
  if (diffStat) {
    bodyParts.push('', '## Changes', '', '```', diffStat, '```');
  }

  const body = bodyParts.join('\n');
  const suffix = nanoid(6).toLowerCase();
  const tempImage = `hermes-pr:${suffix}`;

  try {
    // Commit the stopped container to a temp image
    await $`docker commit ${containerId} ${tempImage}`.quiet();

    // Mount gh credentials and run push + pr create inside the container
    const ghVolume = await getGhConfigVolume();

    // Push the branch and create the PR in one script
    const script = `
set -e
cd /work/app
gh auth setup-git
git push -u origin HEAD
gh pr create --head "${branch}" --repo "${repo}" --title "${title.replace(/"/g, '\\"')}" --body "$(cat <<'PRBODY'
${body}
PRBODY
)" --json number,state,url
`.trim();

    const result =
      await $`docker run --rm -v ${ghVolume} ${tempImage} bash -c ${script}`.quiet();
    const output = result.stdout.toString().trim();

    // The last line of output should be the JSON from gh pr create
    const lines = output.split('\n');
    const jsonLine = lines[lines.length - 1];
    if (!jsonLine) return null;

    const pr = JSON.parse(jsonLine) as GhPrListItem;
    return {
      number: pr.number,
      state: pr.state,
      url: pr.url,
    };
  } catch (err) {
    log.error({ err, repo, branch }, 'Error pushing branch and creating PR');
    throw formatShellError(err as ShellError);
  } finally {
    try {
      await $`docker rmi ${tempImage}`.quiet();
    } catch {
      // Ignore cleanup errors
    }
  }
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
  if (repo === 'local') return null;

  // Session branch names don't include the 'hermes/' prefix, but the actual
  // git branches are created with it (e.g., 'hermes/feature-xyz')
  const branch = sessionName.startsWith('hermes/')
    ? sessionName
    : `hermes/${sessionName}`;

  try {
    const result = await runGhInDocker({
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
