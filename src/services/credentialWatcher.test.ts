import { describe, expect, test } from 'bun:test';
import type {
  ClaudeCredentialsJson,
  CodexAuthJson,
  OpencodeAuthJson,
} from '../types/agentConfig.ts';
import {
  computeContentHash,
  isCredentialFresher,
  mergeOpencodeCredentials,
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

describe('mergeOpencodeCredentials', () => {
  // Use future timestamps to avoid authEntryValid rejecting expired entries
  const future = (offset: number) => Date.now() + offset * 1000;

  test('picks fresher oauth entry per key', () => {
    const existingExpires = future(3600);
    const candidateFresher = future(7200);
    const candidateStaler = future(1800);
    const existingFresher = future(10800);
    const existing: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: existingExpires,
      },
      openai: {
        type: 'oauth',
        access: 'o',
        refresh: 'r',
        expires: existingFresher,
      },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a2',
        refresh: 'r2',
        expires: candidateFresher,
      },
      openai: {
        type: 'oauth',
        access: 'o-old',
        refresh: 'r',
        expires: candidateStaler,
      },
    };
    const result = mergeOpencodeCredentials(candidate, existing);
    expect(result).not.toBeNull();
    // anthropic: candidate is fresher
    expect(result?.anthropic).toEqual({
      type: 'oauth',
      access: 'a2',
      refresh: 'r2',
      expires: candidateFresher,
    });
    // openai: existing is fresher, kept
    expect(result?.openai).toEqual({
      type: 'oauth',
      access: 'o',
      refresh: 'r',
      expires: existingFresher,
    });
  });

  test('returns null when no candidate entries are fresher', () => {
    const existing: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: future(7200),
      },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a-old',
        refresh: 'r',
        expires: future(3600),
      },
    };
    expect(mergeOpencodeCredentials(candidate, existing)).toBeNull();
  });

  test('preserves keys only in existing', () => {
    const existingAnthropicExpires = future(3600);
    const candidateAnthropicExpires = future(7200);
    const existingOpenaiExpires = future(10800);
    const existing: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: existingAnthropicExpires,
      },
      openai: {
        type: 'oauth',
        access: 'o',
        refresh: 'r',
        expires: existingOpenaiExpires,
      },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a2',
        refresh: 'r2',
        expires: candidateAnthropicExpires,
      },
    };
    const result = mergeOpencodeCredentials(candidate, existing);
    expect(result).not.toBeNull();
    expect(
      result?.anthropic?.type === 'oauth' && result?.anthropic.expires,
    ).toBe(candidateAnthropicExpires);
    expect(result?.openai).toEqual({
      type: 'oauth',
      access: 'o',
      refresh: 'r',
      expires: existingOpenaiExpires,
    });
  });

  test('ignores api key entries in candidate', () => {
    const existing: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: future(3600),
      },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: { type: 'api', key: 'sk-xxx' },
    };
    // api key should not overwrite oauth entry
    expect(mergeOpencodeCredentials(candidate, existing)).toBeNull();
  });

  test('ignores api key entries in existing during comparison', () => {
    const existing: OpencodeAuthJson = {
      anthropic: { type: 'api', key: 'sk-xxx' },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        expires: future(3600),
        refresh: 'r',
      },
    };
    // oauth candidate should not replace api key entry
    expect(mergeOpencodeCredentials(candidate, existing)).toBeNull();
  });

  test('does not introduce keys only in candidate', () => {
    const existing: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: future(3600),
      },
    };
    const candidate: OpencodeAuthJson = {
      anthropic: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: future(3600),
      },
      openai: {
        type: 'oauth',
        access: 'o',
        refresh: 'r',
        expires: future(7200),
      },
    };
    // new key in candidate that doesn't exist in existing — should not be added
    expect(mergeOpencodeCredentials(candidate, existing)).toBeNull();
  });
});
