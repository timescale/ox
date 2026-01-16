// ============================================================================
// Branch Command - Creates feature branch with isolated DB fork and agent
// ============================================================================

import { Command } from 'commander';
import { type ForkResult, forkDatabase } from '../services/db';
import { startContainer } from '../services/docker';
import {
  generateBranchName,
  getRepoInfo,
  type RepoInfo,
} from '../services/git';
import { ensureGitignore } from '../utils';

interface BranchOptions {
  serviceId?: string;
  dbFork: boolean;
}

function printSummary(
  branchName: string,
  repoInfo: RepoInfo,
  forkResult: ForkResult | null,
  _containerId: string,
): void {
  console.log(`
Repository: ${repoInfo.fullName}
Branch: conductor/${branchName}${
    forkResult
      ? `
Database: ${forkResult.name} (service ID: ${forkResult.service_id})`
      : ''
  }
Container: conductor-${branchName}

To view agent logs:
  docker logs -f conductor-${branchName}

To stop the agent:
  docker stop conductor-${branchName}
`);
}

async function branchAction(
  prompt: string,
  options: BranchOptions,
): Promise<void> {
  // Step 1: Get repo info
  console.log('Getting repository info...');
  const repoInfo = await getRepoInfo();
  console.log(`  Repository: ${repoInfo.fullName}`);

  // Step 2: Generate branch name
  console.log('Generating branch name...');
  const branchName = await generateBranchName(prompt);
  console.log(`  Branch name: ${branchName}`);

  // Step 3: Ensure .gitignore has .conductor/ entry
  await ensureGitignore();

  // Step 4: Fork database (unless --no-db-fork is set)
  let forkResult: ForkResult | null = null;
  if (!options.dbFork) {
    console.log('Skipping database fork (--no-db-fork)');
  } else {
    console.log('Forking database (this may take a few minutes)...');
    forkResult = await forkDatabase(branchName, options.serviceId);
    console.log(`  Database fork created: ${forkResult.name}`);
  }

  // Step 5: Start container (repo will be cloned inside container)
  console.log('Starting agent container...');
  const containerId = await startContainer(
    branchName,
    prompt,
    repoInfo,
    forkResult?.envVars,
  );
  console.log(`  Container started: ${containerId.substring(0, 12)}`);

  // Summary
  printSummary(branchName, repoInfo, forkResult, containerId);
}

export const branchCommand = new Command('branch')
  .description(
    'Create a feature branch with isolated DB fork and start agent sandbox',
  )
  .argument('<prompt>', 'Natural language description of the task')
  .option(
    '-s, --service-id <id>',
    "Database service ID to fork (defaults to tiger's default)",
  )
  .option('--no-db-fork', 'Skip the database fork step')
  .action(branchAction);
