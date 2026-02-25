// ============================================================================
// Resume Command - Resume a stopped hermes agent
// ============================================================================

import { Command } from 'commander';
import { log } from '../services/logger.ts';
import {
  getProviderForSession,
  getSandboxProvider,
  listAllSessions,
} from '../services/sandbox';

export async function resumeAction(
  containerId: string,
  prompt: string | undefined,
  options: { detach?: boolean; shell?: boolean },
): Promise<void> {
  if (options.detach && (!prompt || prompt.trim().length === 0)) {
    log.error('Prompt is required for detached resume');
    console.error('Error: prompt is required for detached resume');
    process.exit(1);
  }

  if (options.detach && options.shell) {
    log.error('--detach and --shell cannot be used together');
    console.error('Error: --detach and --shell cannot be used together');
    process.exit(1);
  }

  log.debug({ containerId, options }, 'Resolving session for resume');
  const sessions = await listAllSessions();
  const resolvedSession = sessions.find(
    (session) => session.name === containerId,
  );
  const fallbackSession = sessions.find(
    (session) =>
      session.containerName === containerId || session.id === containerId,
  );
  let targetSession = resolvedSession ?? fallbackSession;
  if (!targetSession) {
    log.debug(
      { containerId },
      'Session not found in list, querying providers directly',
    );
    for (const providerType of ['docker', 'cloud'] as const) {
      const provider = getSandboxProvider(providerType);
      const found = await provider.get(containerId);
      if (found) {
        targetSession = found;
        break;
      }
    }
  }
  const targetId = targetSession?.id ?? containerId;
  const provider = targetSession ? getProviderForSession(targetSession) : null;
  log.debug(
    { targetId, provider: targetSession?.provider },
    'Session resolved',
  );

  try {
    const mode = options.shell
      ? 'shell'
      : options.detach
        ? 'detached'
        : 'interactive';
    if (!provider) {
      throw new Error(`Session not found: ${containerId}`);
    }
    const result = await provider.resume(targetId, {
      mode,
      prompt,
    });
    if (mode === 'detached') {
      log.info(
        { name: result.name, sessionId: result.id },
        'Resumed session started',
      );
      console.log(`Resumed session started: ${result.name ?? result.id}`);
    } else if (mode === 'shell') {
      // Shell mode — open a plain bash shell in the container
      await provider.shell(result.id);
    } else {
      // Interactive mode — attach to the session
      await provider.attach(result.id);
    }
  } catch (err) {
    log.error({ err }, 'Failed to resume session');
    console.error(`Failed to resume: ${err}`);
    process.exit(1);
  }
}

export const resumeCommand = new Command('resume')
  .description('Resume a stopped hermes session')
  .argument('<session>', 'Session name to resume')
  .argument('[prompt]', 'Prompt for the resumed agent')
  .option('-d, --detach', 'Resume in detached mode (runs agent in background)')
  .option('-s, --shell', 'Resume with a bash shell instead of the agent')
  .action(resumeAction);
