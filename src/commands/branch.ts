// ============================================================================
// Branch Action - Creates feature branch with isolated DB fork and agent
// ============================================================================

import { YAML } from 'bun';
import { type Command, Option } from 'commander';
import { ensureGhAuth } from '../components/GhAuth.tsx';
import { ensureClaudeAuth } from '../services/claude';
import { ensureCodexAuth } from '../services/codex';
import { type AgentType, projectConfig, readConfig } from '../services/config';
import { type ForkResult, forkDatabase } from '../services/db';
import { generateBranchName, tryGetRepoInfo } from '../services/git';
import { log } from '../services/logger.ts';
import { ensureOpencodeAuth } from '../services/opencode';
import type { RequestSudoFn } from '../services/portForwarding/sudo.ts';
import type { SandboxProviderType } from '../services/sandbox';
import { getDefaultProvider, getSandboxProvider } from '../services/sandbox';
import { printErr } from '../utils/shell.ts';
import { configAction } from './config';

interface BranchOptions {
  serviceId?: string;
  dbFork: boolean;
  agent?: AgentType;
  model?: string;
  follow: boolean;
  interactive: boolean;
  agentMode?: 'async' | 'interactive' | 'plan';
  output: 'id' | 'json' | 'yaml';
  /** Mount local directory instead of git clone. True = cwd, string = specific path */
  mount?: string | true;
  /** Sandbox provider override (docker or cloud) */
  provider?: SandboxProviderType;
}

/**
 * Validate mutually exclusive CLI options. Call this early — before any
 * routing logic — so that invalid flag combinations are always caught.
 */
export function validateBranchOptions(options: BranchOptions): void {
  if (options.follow && options.interactive) {
    log.error('--follow and --interactive are mutually exclusive');
    console.error('Error: --follow and --interactive are mutually exclusive');
    process.exit(1);
  }

  const effectiveAgentMode = options.agentMode ?? 'async';
  if (options.follow && effectiveAgentMode !== 'async') {
    log.error('--follow requires --agent-mode=async');
    console.error(
      'Error: --follow requires --agent-mode=async (interactive and plan agents need a full tui)',
    );
    process.exit(1);
  }

  if (options.output && options.output !== 'id') {
    if (options.follow) {
      console.error('Error: --output and --follow are mutually exclusive');
      process.exit(1);
    }
    if (options.interactive) {
      console.error('Error: --output and --interactive are mutually exclusive');
      process.exit(1);
    }
  }
}

export async function branchAction(
  prompt: string,
  options: BranchOptions,
): Promise<void> {
  // Safety net — callers should validate early, but ensure it here too
  validateBranchOptions(options);

  const effectiveAgentMode = options.agentMode ?? 'async';

  const provider = options.provider
    ? getSandboxProvider(options.provider)
    : await getDefaultProvider();
  await provider.ensureReady();

  // Step 1: Check if we're in a git repository
  const repoInfo = await tryGetRepoInfo();
  const isGitRepo = repoInfo !== null;

  // Force mount mode if not in a git repo
  const forcedMount = !isGitRepo && !options.mount;
  if (forcedMount) {
    log.info(
      'Not in a git repository. Using mount mode with current directory.',
    );
    printErr(
      'Not in a git repository. Using mount mode with current directory.',
    );
    options.mount = true;
  }

  // Only require GitHub auth if in a git repo
  if (isGitRepo) {
    await ensureGhAuth();
  }

  // Step 2: Read merged config for defaults, run config wizard if no project config exists
  if (!(await projectConfig.exists())) {
    log.info('No project config found. Running config wizard...');
    printErr('No project config found. Running config wizard...\n');
    await configAction();
    // Verify project config was created
    if (!(await projectConfig.exists())) {
      log.error('Config was cancelled or failed. Cannot continue.');
      console.error('Config was cancelled or failed. Cannot continue.');
      process.exit(1);
    }
    printErr(''); // blank line after config
  }

  // Read merged config for effective values
  const config = await readConfig();

  // Step 4: Determine effective values from options or config
  const effectiveServiceId = options.serviceId ?? config.tigerServiceId;
  const effectiveAgent: AgentType = options.agent ?? config.agent ?? 'opencode';
  const effectiveModel: string | undefined =
    options.model ?? config.agentModels?.[effectiveAgent] ?? config.model;

  // Step 4b: Ensure sandbox image (including agent overlay) is ready
  printErr('Ensuring sandbox image...');
  await provider.ensureImage({ agent: effectiveAgent });

  // Step 5: Get repo info (if in a git repo)
  if (isGitRepo) {
    log.debug({ repo: repoInfo.fullName }, 'Repository info resolved');
    printErr('Getting repository info...');
    printErr(`  Repository: ${repoInfo.fullName}`);
  }

  // Step 6: Generate branch name using configured agent and model
  log.debug('Generating branch name');
  printErr('Generating branch name...');
  const branchName = await generateBranchName({
    prompt,
    agent: effectiveAgent,
    model: effectiveModel,
    onProgress: printErr,
  });
  log.debug({ branchName }, 'Branch name generated');
  printErr(`  Branch name: ${branchName}`);

  // Step 7: Fork database (only if explicitly configured with a service ID)
  let forkResult: ForkResult | null = null;
  if (!options.dbFork) {
    log.debug('Skipping database fork (--no-db-fork)');
    printErr('Skipping database fork (--no-db-fork)');
  } else if (!effectiveServiceId) {
    // Default is to skip fork unless a service ID is explicitly configured
    log.debug('Skipping database fork (no service ID configured)');
    printErr('Skipping database fork (no service ID configured)');
  } else {
    log.info('Forking database (this may take a few minutes)...');
    printErr('Forking database (this may take a few minutes)...');
    forkResult = await forkDatabase(branchName, effectiveServiceId);
    log.info({ name: forkResult.name }, 'Database fork created');
    printErr(`  Database fork created: ${forkResult.name}`);
  }

  // Step 8: Ensure agent credentials are valid
  log.debug({ agent: effectiveAgent }, 'Checking agent credentials');
  printErr(`Checking ${effectiveAgent} credentials...`);
  let authValid: boolean;
  switch (effectiveAgent) {
    case 'claude':
      authValid = await ensureClaudeAuth(effectiveModel);
      break;
    case 'codex':
      authValid = await ensureCodexAuth(effectiveModel);
      break;
    default:
      authValid = await ensureOpencodeAuth(effectiveModel);
      break;
  }

  if (!authValid) {
    log.error(
      { agent: effectiveAgent },
      'Agent credentials are invalid. Cannot start agent.',
    );
    console.error(
      `\nError: ${effectiveAgent} credentials are invalid. Cannot start agent.`,
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
  printErr(
    `Starting agent container (using ${effectiveAgent}${effectiveModel ? ` with ${effectiveModel}` : ''})${mountDir ? ' [mount mode]' : ''}...`,
  );
  const isInteractiveAgent =
    effectiveAgentMode === 'interactive' || effectiveAgentMode === 'plan';

  // CLI requestSudo: spawn `sudo -v` with inherited stdio so the user can
  // type their password directly. No TUI to suspend/resume here.
  const requestSudo: RequestSudoFn = async (reason) => {
    printErr(`\n${reason}`);
    const proc = Bun.spawn(['sudo', '-v'], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  };

  const session = await provider.create({
    branchName,
    name: branchName,
    prompt,
    repoInfo,
    agent: effectiveAgent,
    model: effectiveModel,
    interactive: isInteractiveAgent,
    envVars: forkResult?.envVars,
    mountDir,
    isGitRepo,
    agentMode: effectiveAgentMode,
    onProgress: printErr,
    requestSudo,
    agentArgs:
      effectiveAgentMode === 'plan'
        ? effectiveAgent === 'claude'
          ? ['--permission-mode', 'plan']
          : effectiveAgent === 'opencode'
            ? ['--agent', 'plan']
            : undefined // codex: no plan mode CLI support
        : undefined,
  });

  if (options.follow) {
    // Follow mode: stream container logs until the session exits
    const stream = provider.streamLogs(session.id);

    process.on('SIGINT', () => {
      stream.stop();
      process.exit(0);
    });

    for await (const line of stream.lines) {
      console.log(line);
    }

    // Re-fetch session to get exit code after stream ends
    const finalSession = await provider.get(session.id);
    const exitCode = finalSession?.exitCode ?? 0;
    log.info({ agent: effectiveAgent, exitCode }, 'Agent session ended');
    printErr(`\n${effectiveAgent} session ended.`);
    process.exit(exitCode);
  } else {
    // Detached mode: print session info to stdout and exit immediately
    switch (options.output) {
      case 'json':
        console.log(JSON.stringify(session, null, 2));
        break;
      case 'yaml':
        console.log(YAML.stringify(session, null, 2));
        break;
      default:
        if (session?.id) {
          console.log(session.id);
        }
        break;
    }
    process.exit(0);
  }
}

/**
 * Add the standard branch command options to a Command instance
 */
export function withBranchOptions<T extends Command>(cmd: T): T {
  return cmd
    .option(
      '-s, --service-id <id>',
      'Database service ID to fork (defaults to .ox config or tiger default)',
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
      '-f, --follow',
      'Stream agent output to terminal (exit when agent finishes)',
    )
    .option('-i, --interactive', 'Launch full TUI experience')
    .addOption(
      new Option('-M, --agent-mode <mode>', 'Agent execution mode').choices([
        'async',
        'interactive',
        'plan',
      ]),
    )
    .addOption(
      new Option('-o, --output <format>', 'Output format for session info')
        .choices(['id', 'json', 'yaml'])
        .default('id'),
    )
    .option(
      '--mount [dir]',
      'Mount local directory into container instead of git clone (defaults to cwd)',
    )
    .addOption(
      new Option(
        '-r, --provider <type>',
        'Sandbox provider (overrides config)',
      ).choices(['docker', 'cloud']),
    ) as T;
}
