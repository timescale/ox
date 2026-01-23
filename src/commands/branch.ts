// ============================================================================
// Branch Command - Creates feature branch with isolated DB fork and agent
// ============================================================================

import { Command } from 'commander';
import { runDockerSetupScreen } from '../components/DockerSetupScreen';
import { type AgentType, readConfig } from '../services/config';
import { type ForkResult, forkDatabase } from '../services/db';
import { ensureDockerImage, startContainer } from '../services/docker';
import {
  generateBranchName,
  getRepoInfo,
  type RepoInfo,
} from '../services/git';
import { ensureGitignore } from '../utils';
import { initAction } from './init';

interface BranchOptions {
  serviceId?: string;
  dbFork: boolean;
  agent?: AgentType;
  model?: string;
  print: boolean;
  interactive: boolean;
}

function printSummary(
  branchName: string,
  repoInfo: RepoInfo,
  forkResult: ForkResult | null,
): void {
  console.log(`
Repository: ${repoInfo.fullName}
Branch: hermes/${branchName}${
    forkResult
      ? `
Database: ${forkResult.name} (service ID: ${forkResult.service_id})`
      : ''
  }
Container: hermes-${branchName}

To view agent logs:
  docker logs -f hermes-${branchName}

To stop the agent:
  docker stop hermes-${branchName}
`);
}

export async function branchAction(
  prompt: string,
  options: BranchOptions,
): Promise<void> {
  // Validate mutually exclusive options
  if (options.print && options.interactive) {
    console.error('Error: --print and --interactive are mutually exclusive');
    process.exit(1);
  }

  // Step 1: Get repo info
  console.log('Getting repository info...');
  const repoInfo = await getRepoInfo();
  console.log(`  Repository: ${repoInfo.fullName}`);

  // Step 2: Generate branch name
  console.log('Generating branch name...');
  const branchName = await generateBranchName(prompt);
  console.log(`  Branch name: ${branchName}`);

  // Step 3: Ensure .gitignore has .hermes/ entry
  await ensureGitignore();

  // Step 4: Read config for defaults, run init if no config exists
  let config = await readConfig();
  if (!config) {
    console.log('No config found. Running init wizard...\n');
    await initAction();
    // Re-read config after init
    config = await readConfig();
    if (!config) {
      console.error('Init was cancelled or failed. Cannot continue.');
      process.exit(1);
    }
    console.log(''); // blank line after init
  }

  // Step 5: Determine effective values from options or config
  const effectiveServiceId = options.serviceId ?? config.tigerServiceId;
  const effectiveAgent: AgentType = options.agent ?? config.agent ?? 'opencode';
  const effectiveModel: string | undefined = options.model ?? config.model;

  // Step 6: Fork database (only if explicitly configured with a service ID)
  let forkResult: ForkResult | null = null;
  if (!options.dbFork) {
    console.log('Skipping database fork (--no-db-fork)');
  } else if (!effectiveServiceId) {
    // Default is to skip fork unless a service ID is explicitly configured
    console.log('Skipping database fork (no service ID configured)');
  } else {
    console.log('Forking database (this may take a few minutes)...');
    forkResult = await forkDatabase(branchName, effectiveServiceId);
    console.log(`  Database fork created: ${forkResult.name}`);
  }

  // Step 7: Ensure Docker is ready (installed and running)
  const dockerResult = await runDockerSetupScreen();
  if (dockerResult.type === 'cancelled') {
    console.log('Cancelled.');
    return;
  }
  if (dockerResult.type === 'error') {
    console.error(`Docker setup failed: ${dockerResult.error}`);
    process.exit(1);
  }

  // Step 8: Ensure Docker image exists (build if missing)
  await ensureDockerImage();

  // Step 9: Start container (repo will be cloned inside container)
  console.log(
    `Starting agent container (using ${effectiveAgent}${effectiveModel ? ` with ${effectiveModel}` : ''})...`,
  );
  // Default to detached mode unless --print or --interactive is specified
  const detach = !options.print && !options.interactive;

  const containerId = await startContainer({
    branchName,
    prompt,
    repoInfo,
    agent: effectiveAgent,
    model: effectiveModel,
    detach,
    interactive: options.interactive,
    envVars: forkResult?.envVars,
  });

  if (detach) {
    console.log(`  Container started: ${containerId?.substring(0, 12)}`);
    // Summary only shown in detached mode
    printSummary(branchName, repoInfo, forkResult);
  } else if (options.interactive) {
    // Interactive mode exited
    console.log(`\n${effectiveAgent} session ended.`);
  }
}

/**
 * Add the standard branch command options to a Command instance
 */
export function withBranchOptions<T extends Command>(cmd: T): T {
  return cmd
    .option(
      '-s, --service-id <id>',
      'Database service ID to fork (defaults to .hermes config or tiger default)',
    )
    .option('--no-db-fork', 'Skip the database fork step')
    .option(
      '-a, --agent <type>',
      'Agent to use: claude or opencode (defaults to config or opencode)',
    )
    .option(
      '-m, --model <model>',
      'Model to use for the agent (defaults to config)',
    )
    .option(
      '-p, --print',
      'Attach container output to console (default: detached)',
    )
    .option('-i, --interactive', 'Run agent in full TUI mode') as T;
}

export const branchCommand = withBranchOptions(
  new Command('branch')
    .description(
      'Create a feature branch with isolated DB fork and start agent sandbox',
    )
    .argument('<prompt>', 'Natural language description of the task'),
).action(branchAction);
