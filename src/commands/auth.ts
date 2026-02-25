// ============================================================================
// Auth Command - Manage authentication tokens
// ============================================================================

import { Command } from 'commander';
import { ensureGhAuth } from '../components/GhAuth';
import { checkClaudeCredentials, ensureClaudeAuth } from '../services/claude';
import { ensureDockerSandbox } from '../services/docker';
import { checkGhCredentials } from '../services/gh';
import {
  deleteCredentials as deleteGhAppCredentials,
  readCredentials as readGhAppCredentials,
} from '../services/githubApp';
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
      switch (provider) {
        case 'claude': {
          await ensureDockerSandbox();
          if (await checkClaudeCredentials()) {
            console.log('Claude CLI credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('Claude CLI credentials are invalid.');
          break;
        }
        case 'opencode': {
          await ensureDockerSandbox();
          if (await checkOpencodeCredentials()) {
            console.log('OpenCode credentials are valid.');
            process.exit(0);
            return;
          }
          console.error('OpenCode credentials are invalid.');
          break;
        }
        case 'gh': {
          // Check GitHub App credentials first (no Docker needed)
          const appCreds = await readGhAppCredentials();
          if (appCreds) {
            console.log(
              `GitHub credentials are valid (authenticated as @${appCreds.username} via Hermes GitHub App).`,
            );
            process.exit(0);
            return;
          }

          // Fall back to checking via Docker (host gh / keyring cache)
          await ensureDockerSandbox();
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
      switch (provider) {
        case 'claude': {
          await ensureDockerSandbox();
          if (await ensureClaudeAuth()) {
            console.log('Claude credentials are valid.');
            break;
          }
          console.error('Claude login failed or was cancelled.');
          process.exit(1);
          break;
        }
        case 'opencode': {
          await ensureDockerSandbox();
          if (await ensureOpencodeAuth()) {
            console.log('OpenCode credentials are valid.');
            break;
          }
          console.error('OpenCode login failed or was cancelled.');
          process.exit(1);
          break;
        }
        case 'gh': {
          // GitHub App auth doesn't need Docker
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

authCommand
  .command('logout')
  .description('Remove stored credentials for a provider')
  .argument('<provider>', 'The provider to logout: gh')
  .action(async (provider: string) => {
    try {
      switch (provider) {
        case 'gh': {
          await deleteGhAppCredentials();
          console.log('GitHub App credentials have been removed.');
          break;
        }
        default: {
          console.error(`Logout is not supported for provider: ${provider}`);
          process.exit(1);
          break;
        }
      }
    } catch (err) {
      log.error({ err }, 'Error during logout');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
