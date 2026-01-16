// ============================================================================
// Docker Container Service
// ============================================================================

import { formatShellError, type ShellError } from '../utils';
import type { RepoInfo } from './git';

export async function startContainer(
  branchName: string,
  prompt: string,
  repoInfo: RepoInfo,
  envVars?: Record<string, string>,
): Promise<string> {
  const conductorEnvPath = '.conductor/.env';
  const conductorEnvFile = Bun.file(conductorEnvPath);

  // Create empty .conductor/.env if it doesn't exist
  if (!(await conductorEnvFile.exists())) {
    await Bun.write(conductorEnvPath, '');
  }

  const containerName = `conductor-${branchName}`;

  // Build env var arguments for docker run
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(envVars ?? {})) {
    envArgs.push('-e', `${key}=${value}`);
  }

  // Build the startup script that:
  // 1. Clones the repo using gh
  // 2. Creates and checks out the new branch
  // 3. Runs claude with the prompt
  const startupScript = `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
git switch -c "conductor/${branchName}"
exec claude -p --dangerously-skip-permissions \\
  "${prompt.replace(/"/g, '\\"')}

Use the \\\`gh\\\` command to create a PR when done."
`.trim();

  try {
    const result = await Bun.$`docker run -d \
      --name ${containerName} \
      --env-file ${conductorEnvPath} \
      ${envArgs} \
      conductor-sandbox \
      bash -c ${startupScript}`;
    return result.stdout.toString().trim();
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
}
