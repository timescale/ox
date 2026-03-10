import { describe, expect, test } from 'bun:test';
import type {
  ClaudeCredentialsJson,
  CodexAuthJson,
  OpencodeAuthJson,
} from '../types/agentConfig.ts';
import {
  computeContentHash,
  isCredentialFresher,
} from './credentialWatcher.ts';

describe('computeContentHash', () => {
  test('returns consistent hash for same content', () => {
    const hash1 = computeContentHash('{"key":"value"}');
    const hash2 = computeContentHash('{"key":"value"}');
    expect(hash1).toBe(hash2);
  });

  test('returns different hash for different content', () => {
    const hash1 = computeContentHash('{"key":"value1"}');
    const hash2 = computeContentHash('{"key":"value2"}');
    expect(hash1).not.toBe(hash2);
  });

  test('returns empty string for null/undefined', () => {
    expect(computeContentHash(null)).toBe('');
    expect(computeContentHash(undefined)).toBe('');
  });
});

describe('isCredentialFresher', () => {
  test('claude: newer expiresAt wins', () => {
    const older: ClaudeCredentialsJson = {
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1000 },
    };
    const newer: ClaudeCredentialsJson = {
      claudeAiOauth: { accessToken: 'b', refreshToken: 'r2', expiresAt: 2000 },
    };
    expect(isCredentialFresher('claude', newer, older)).toBe(true);
    expect(isCredentialFresher('claude', older, newer)).toBe(false);
  });

  test('claude: candidate without expiresAt is not fresher', () => {
    const existing: ClaudeCredentialsJson = {
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1000 },
    };
    const candidate: ClaudeCredentialsJson = {
      claudeAiOauth: { accessToken: 'b', refreshToken: 'r2' },
    };
    expect(isCredentialFresher('claude', candidate, existing)).toBe(false);
  });

  test('opencode: newer expires wins per-provider', () => {
    const older: OpencodeAuthJson = {
      anthropic: { type: 'oauth', access: 'a', expires: 1000 },
    };
    const newer: OpencodeAuthJson = {
      anthropic: { type: 'oauth', access: 'b', expires: 2000 },
    };
    expect(isCredentialFresher('opencode', newer, older)).toBe(true);
  });

  test('codex: newer expires_at wins (legacy field)', () => {
    const older: CodexAuthJson = { access_token: 'a', expires_at: 1000 };
    const newer: CodexAuthJson = { access_token: 'b', expires_at: 2000 };
    expect(isCredentialFresher('codex', newer, older)).toBe(true);
  });

  test('codex: nested tokens format with no expires_at is treated as fresh', () => {
    const existing: CodexAuthJson = { access_token: 'a', expires_at: 1000 };
    const candidate: CodexAuthJson = {
      tokens: { access_token: 'b', refresh_token: 'r' },
    };
    expect(isCredentialFresher('codex', candidate, existing)).toBe(true);
  });
});
