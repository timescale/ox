import { describe, expect, test } from 'bun:test';
import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_INSTALL_URL,
  GITHUB_APP_SLUG,
} from './githubApp';

describe('githubApp', () => {
  test('GITHUB_APP_CLIENT_ID is defined and non-empty', () => {
    expect(GITHUB_APP_CLIENT_ID).toBeDefined();
    expect(GITHUB_APP_CLIENT_ID.length).toBeGreaterThan(0);
  });

  test('GITHUB_APP_CLIENT_ID looks like a GitHub App client ID', () => {
    // GitHub App client IDs start with "Iv" followed by digits and alphanumeric chars
    expect(GITHUB_APP_CLIENT_ID).toMatch(/^Iv/);
  });

  test('GITHUB_APP_SLUG is defined', () => {
    expect(GITHUB_APP_SLUG).toBe('hermes-cli');
  });

  test('GITHUB_APP_INSTALL_URL uses the slug', () => {
    expect(GITHUB_APP_INSTALL_URL).toBe(
      'https://github.com/apps/hermes-cli/installations/new',
    );
  });
});
