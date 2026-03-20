// Auth management - check and login to various providers

import { Command } from 'commander';
import { ensureGhAuth } from '../components/GhAuth';
import { checkClaudeCredentials, ensureClaudeAuth } from '../services/claude';
import { checkCodexCredentials, ensureCodexAuth } from '../services/codex';
import { ensureDockerSandbox } from '../services/docker';
import { checkGhCredentials } from '../services/gh';
import { log } from '../services/logger';
import {
  checkOpencodeCredentials,
  ensureOpencodeAuth,
} from '../services/opencode';
import type { ShellError } from '../utils/shell.ts';

export const authCommand = new Command('auth').description(
  'Manage authentication tokens',
);

authCommand
  .command('check')
  .aliases(['status', 'c', 's'])
  .description('Check authentication status')
  .argument('<provider>', 'The provider to check: claude, opencode, codex, gh')
  .option('-m, --model <model>', 'Model to test API access with')
  .action(async (provider: string, options: { model?: string }) => {
    try {
      const { model } = options;

      // Validate --model is not used with gh provider
      if (provider === 'gh' && model) {
        console.error(
          'The --model flag is not applicable to GitHub authentication',
        );
        process.exit(1);
        return;
      }

      await ensureDockerSandbox();
      switch (provider) {
        case 'claude': {
          if (await checkClaudeCredentials(model)) {
            console.log('Claude CLI credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('Claude CLI credentials are invalid.');
          break;
        }
        case 'opencode': {
          if (await checkOpencodeCredentials(model)) {
            console.log('OpenCode credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('OpenCode credentials are invalid.');
          break;
        }
        case 'codex': {
          if (await checkCodexCredentials(model)) {
            console.log('Codex credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('Codex credentials are invalid.');
          break;
        }
        case 'gh': {
          if (await checkGhCredentials()) {
            console.log('GitHub credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('GitHub credentials are invalid.');
          break;
        }
        default: {
          console.error(`Unknown provider: ${provider}`);
          break;
        }
      }
      process.exit(1);
    } catch (err) {
      log.error({ err }, 'Error checking credentials');
      process.exit((err as ShellError).exitCode || 1);
    }
  });

authCommand
  .command('login')
  .description('Ensure the provider is logged in')
  .argument('<provider>', 'The provider to login: claude, opencode, codex, gh')
  .action(async (provider: string) => {
    try {
      await ensureDockerSandbox();
      switch (provider) {
        case 'claude': {
          if (await ensureClaudeAuth()) {
            console.log('Claude credentials are valid.');
            break;
          }
          console.error('Claude login failed or was cancelled.');
          process.exit(1);
          break;
        }
        case 'opencode': {
          if (await ensureOpencodeAuth()) {
            console.log('OpenCode credentials are valid.');
            break;
          }
          console.error('OpenCode login failed or was cancelled.');
          process.exit(1);
          break;
        }
        case 'codex': {
          if (await ensureCodexAuth()) {
            console.log('Codex credentials are valid.');
            break;
          }
          console.error('Codex login failed or was cancelled.');
          process.exit(1);
          break;
        }
        case 'gh': {
          await ensureGhAuth();
          console.log('GitHub credentials are valid.');
          break;
        }
        default: {
          console.error(`Unknown provider: ${provider}`);
          process.exit(1);
          break;
        }
      }
    } catch (err) {
      log.error({ err }, 'Error checking credentials');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
