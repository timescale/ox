// ============================================================================
// Branch Command - Creates feature branch with isolated DB fork and agent
// ============================================================================

import { Command, Option } from 'commander';
import { ensureGhAuth } from '../components/GhAuth.tsx';
import { ensureClaudeAuth } from '../services/claude';
import { type AgentType, projectConfig, readConfig } from '../services/config';
import { type ForkResult, forkDatabase } from '../services/db';
import {
  generateBranchName,
  type RepoInfo,
  tryGetRepoInfo,
} from '../services/git';
import { log } from '../services/logger.ts';
import { ensureOpencodeAuth } from '../services/opencode';
import type { SandboxProviderType } from '../services/sandbox';
import { getDefaultProvider, getSandboxProvider } from '../services/sandbox';
import { ensureGitignore } from '../utils';
import { configAction } from './config';

interface BranchOptions {
  serviceId?: string;
  dbFork: boolean;
  agent?: AgentType;
  model?: string;
  print: boolean;
  interactive: boolean;
  /** Mount local directory instead of git clone. True = cwd, string = specific path */
  mount?: string | true;
  /** Sandbox provider override (docker or cloud) */
  provider?: SandboxProviderType;
}

function printSummary(
  branchName: string,
  repoInfo: RepoInfo | null,
  forkResult: ForkResult | null,
): void {
  log.info(
    {
      branchName,
      repo: repoInfo?.fullName ?? 'local',
      database: forkResult?.name,
      container: `hermes-${branchName}`,
    },
    'Branch session created',
  );
}

export async function branchAction(
  prompt: string,
  options: BranchOptions,
): Promise<void> {
  // Validate mutually exclusive options
  if (options.print && options.interactive) {
    log.error('--print and --interactive are mutually exclusive');
    process.exit(1);
  }

  const provider = options.provider
    ? getSandboxProvider(options.provider)
    : await getDefaultProvider();
  await provider.ensureReady();
  await provider.ensureImage();

  // Step 1: Check if we're in a git repository
  const repoInfo = await tryGetRepoInfo();
  const isGitRepo = repoInfo !== null;

  // Force mount mode if not in a git repo
  const forcedMount = !isGitRepo && !options.mount;
  if (forcedMount) {
    log.info(
      'Not in a git repository. Using mount mode with current directory.',
    );
    options.mount = true;
  }

  // Only require GitHub auth if in a git repo
  if (isGitRepo) {
    await ensureGhAuth();
  }

  // Step 2: Ensure .gitignore has .hermes/ entry (only if in a git repo)
  if (isGitRepo) {
    await ensureGitignore();
  }

  // Step 3: Read merged config for defaults, run config wizard if no project config exists
  if (!(await projectConfig.exists())) {
    log.info('No project config found. Running config wizard...');
    await configAction();
    // Verify project config was created
    if (!(await projectConfig.exists())) {
      log.error('Config was cancelled or failed. Cannot continue.');
      process.exit(1);
    }
  }

  // Read merged config for effective values
  const config = await readConfig();

  // Step 4: Determine effective values from options or config
  const effectiveServiceId = options.serviceId ?? config.tigerServiceId;
  const effectiveAgent: AgentType = options.agent ?? config.agent ?? 'opencode';
  const effectiveModel: string | undefined = options.model ?? config.model;

  // Step 5: Get repo info (if in a git repo)
  if (isGitRepo) {
    log.debug({ repo: repoInfo.fullName }, 'Repository info resolved');
  }

  // Step 6: Generate branch name using configured agent and model
  log.debug('Generating branch name');
  const branchName = await generateBranchName({
    prompt,
    agent: effectiveAgent,
    model: effectiveModel,
    onProgress: (msg) => log.debug(msg),
  });
  log.debug({ branchName }, 'Branch name generated');

  // Step 7: Fork database (only if explicitly configured with a service ID)
  let forkResult: ForkResult | null = null;
  if (!options.dbFork) {
    log.debug('Skipping database fork (--no-db-fork)');
  } else if (!effectiveServiceId) {
    // Default is to skip fork unless a service ID is explicitly configured
    log.debug('Skipping database fork (no service ID configured)');
  } else {
    log.info('Forking database (this may take a few minutes)...');
    forkResult = await forkDatabase(branchName, effectiveServiceId);
    log.info({ name: forkResult.name }, 'Database fork created');
  }

  // Step 8: Ensure agent credentials are valid
  log.debug({ agent: effectiveAgent }, 'Checking agent credentials');
  const authValid =
    effectiveAgent === 'claude'
      ? await ensureClaudeAuth(effectiveModel)
      : await ensureOpencodeAuth(effectiveModel);

  if (!authValid) {
    log.error(
      { agent: effectiveAgent },
      'Agent credentials are invalid. Cannot start agent.',
    );
    process.exit(1);
  }

  // Step 9: Start container (repo will be cloned or mounted)
  // Resolve mount directory: true means cwd, string means specific path
  const mountDir =
    options.mount === true
      ? process.cwd()
      : typeof options.mount === 'string'
        ? options.mount
        : undefined;

  log.info(
    { agent: effectiveAgent, model: effectiveModel, mountDir },
    'Starting agent container',
  );
  // Default to detached mode unless --print or --interactive is specified
  const detach = !options.print && !options.interactive;

  const session = await provider.create({
    branchName,
    name: branchName,
    prompt,
    repoInfo,
    agent: effectiveAgent,
    model: effectiveModel,
    detach,
    interactive: options.interactive,
    envVars: forkResult?.envVars,
    mountDir,
    isGitRepo,
  });

  if (detach) {
    log.debug({ sessionId: session?.id }, 'Container started');
    // Summary only shown in detached mode
    printSummary(branchName, repoInfo, forkResult);
  } else if (options.interactive) {
    // Interactive mode exited
    log.info({ agent: effectiveAgent }, 'Agent session ended');
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
    .option('-i, --interactive', 'Run agent in full TUI mode')
    .option(
      '--mount [dir]',
      'Mount local directory into container instead of git clone (defaults to cwd)',
    )
    .addOption(
      new Option(
        '-r, --provider <type>',
        'Sandbox provider: docker or cloud (overrides config)',
      ).choices(['docker', 'cloud']),
    ) as T;
}

export const branchCommand = withBranchOptions(
  new Command('branch')
    .description(
      'Create a feature branch with isolated DB fork and start agent sandbox',
    )
    .argument('<prompt>', 'Natural language description of the task'),
).action(async (prompt: string, options: BranchOptions) => {
  // -p (print) or -i (interactive) flags: use non-TUI flow
  if (options.print || options.interactive) {
    await branchAction(prompt, options);
    return;
  }

  // Check if we're in a git repository before launching TUI
  const repoInfo = await tryGetRepoInfo();
  const isGitRepo = repoInfo !== null;

  // Force mount mode if not in a git repo
  if (!isGitRepo && !options.mount) {
    log.info(
      'Not in a git repository. Using mount mode with current directory.',
    );
    options.mount = true;
  }

  // Default: use unified TUI
  // Resolve mount directory: true means cwd, string means specific path
  const mountDir =
    options.mount === true
      ? process.cwd()
      : typeof options.mount === 'string'
        ? options.mount
        : undefined;

  const { runSessionsTui } = await import('./sessions.tsx');
  await runSessionsTui({
    initialView: 'starting',
    initialPrompt: prompt,
    initialAgent: options.agent,
    initialModel: options.model,
    serviceId: options.serviceId,
    dbFork: options.dbFork,
    mountDir,
    isGitRepo,
    sandboxProvider: options.provider,
  });
});
