// Pass-through to the claude CLI, running in docker

import { Command } from 'commander';
import { ensureGhAuth } from '../components/GhAuth';
import { checkClaudeCredentials, ensureClaudeAuth } from '../services/claude';
import { ensureDockerSandbox } from '../services/docker';
import { checkGhCredentials } from '../services/gh';
import { log } from '../services/logger';
import {
  checkOpencodeCredentials,
  ensureOpencodeAuth,
} from '../services/opencode';
import type { ShellError } from '../utils';

export const authCommand = new Command('auth').description(
  'Manage authentication tokens',
);

authCommand
  .command('check')
  .aliases(['status', 'c', 's'])
  .description('Check authentication status')
  .argument('<provider>', 'The provider to check: claude, opencode, gh')
  .action(async (provider: string) => {
    try {
      await ensureDockerSandbox();
      switch (provider) {
        case 'claude': {
          if (await checkClaudeCredentials()) {
            console.log('Claude CLI credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('Claude CLI credentials are invalid.');
          break;
        }
        case 'opencode': {
          if (await checkOpencodeCredentials()) {
            console.log('OpenCode credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('OpenCode credentials are invalid.');
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
  .argument('<provider>', 'The provider to login: claude, opencode, gh')
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
