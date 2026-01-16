// ============================================================================
// Docker Container Service
// ============================================================================

import { formatShellError, type ShellError } from '../utils';
import type { RepoInfo } from './git';

export type AgentType = 'claude' | 'opencode';

export interface StartContainerOptions {
  branchName: string;
  prompt: string;
  repoInfo: RepoInfo;
  agent: AgentType;
  detach: boolean;
  interactive: boolean;
  envVars?: Record<string, string>;
}

export async function startContainer(
  options: StartContainerOptions,
): Promise<string | null> {
  const { branchName, prompt, repoInfo, agent, detach, interactive, envVars } =
    options;

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

  // Build the agent command based on the selected agent type and mode
  const agentCommand =
    agent === 'claude'
      ? `claude${interactive ? '' : ' -p'} --dangerously-skip-permissions`
      : `opencode ${interactive ? '--prompt' : 'run'}`;

  // Build the startup script that:
  // 1. Clones the repo using gh
  // 2. Creates and checks out the new branch
  // 3. Runs the selected agent with the prompt
  const startupScript = `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
git switch -c "conductor/${branchName}"
exec ${agentCommand} \\
  "${prompt.replace(/"/g, '\\"')}

Use the \\\`gh\\\` command to create a PR when done."
`.trim();

  try {
    const result = await Bun.$`docker run ${detach ? '-d' : ['-it', '--rm']} \
        --name ${containerName} \
        --env-file ${conductorEnvPath} \
        ${envArgs} \
        conductor-sandbox \
        bash -c ${startupScript}`;
    return detach ? result.stdout.toString().trim() : null;
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
}
