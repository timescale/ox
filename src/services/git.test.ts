import { describe, expect, test } from 'bun:test';
import { isValidBranchName, parseGitHubUrl } from './git';

describe('parseGitHubUrl', () => {
  test('parses HTTPS URL with .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('parses HTTPS URL without .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('parses SSH URL with .git suffix', () => {
    const result = parseGitHubUrl('git@github.com:owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('parses SSH URL without .git suffix', () => {
    const result = parseGitHubUrl('git@github.com:owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('parses SSH URL with ssh:// prefix and .git suffix', () => {
    const result = parseGitHubUrl('ssh://git@github.com/owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('parses SSH URL with ssh:// prefix without .git suffix', () => {
    const result = parseGitHubUrl('ssh://git@github.com/owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  test('handles repo names with hyphens', () => {
    const result = parseGitHubUrl('https://github.com/my-org/my-repo.git');
    expect(result).toEqual({
      owner: 'my-org',
      repo: 'my-repo',
      fullName: 'my-org/my-repo',
    });
  });

  test('handles repo names with underscores', () => {
    const result = parseGitHubUrl('git@github.com:my_org/my_repo.git');
    expect(result).toEqual({
      owner: 'my_org',
      repo: 'my_repo',
      fullName: 'my_org/my_repo',
    });
  });

  test('handles repo names with numbers', () => {
    const result = parseGitHubUrl('https://github.com/org123/repo456.git');
    expect(result).toEqual({
      owner: 'org123',
      repo: 'repo456',
      fullName: 'org123/repo456',
    });
  });

  test('throws error for invalid URL format', () => {
    expect(() => parseGitHubUrl('not-a-url')).toThrow(
      'Unable to parse GitHub repository from remote URL: not-a-url',
    );
  });

  test('throws error for URL with too many path segments', () => {
    expect(() =>
      parseGitHubUrl('https://github.com/owner/repo/extra'),
    ).toThrow();
  });

  test('throws error for URL with only owner', () => {
    expect(() => parseGitHubUrl('https://github.com/owner')).toThrow();
  });

  test('throws error for empty URL', () => {
    expect(() => parseGitHubUrl('')).toThrow();
  });
});

describe('isValidBranchName', () => {
  test('accepts valid lowercase branch name', () => {
    const [valid, reason] = isValidBranchName('add-user-auth');
    expect(valid).toBe(true);
    expect(reason).toBe('');
  });

  test('accepts valid branch name with numbers', () => {
    const [valid, reason] = isValidBranchName('fix-bug-123');
    expect(valid).toBe(true);
    expect(reason).toBe('');
  });

  test('accepts short branch name (5 chars)', () => {
    const [valid, reason] = isValidBranchName('abcde');
    expect(valid).toBe(true);
    expect(reason).toBe('');
  });

  test('accepts branch name ending with number', () => {
    const [valid, reason] = isValidBranchName('feature-v2');
    expect(valid).toBe(true);
    expect(reason).toBe('');
  });

  test('rejects branch name that is too short (< 5 chars)', () => {
    const [valid, reason] = isValidBranchName('ab');
    expect(valid).toBe(false);
    expect(reason).toBe('too short');
  });

  test('rejects single letter branch name', () => {
    const [valid, reason] = isValidBranchName('a');
    expect(valid).toBe(false);
    expect(reason).toBe('too short');
  });

  test('rejects branch name that is too long (> 50 chars)', () => {
    const longName = 'a'.repeat(51);
    const [valid, reason] = isValidBranchName(longName);
    expect(valid).toBe(false);
    expect(reason).toBe('too long');
  });

  test('rejects branch name with uppercase letters', () => {
    const [valid, reason] = isValidBranchName('Add-Feature');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects branch name starting with number', () => {
    const [valid, reason] = isValidBranchName('123-feature');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects branch name with underscores', () => {
    const [valid, reason] = isValidBranchName('add_feature');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects branch name ending with hyphen', () => {
    const [valid, reason] = isValidBranchName('feature-');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects branch name starting with hyphen', () => {
    const [valid, reason] = isValidBranchName('-feature');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects branch name with double hyphens', () => {
    const [valid, reason] = isValidBranchName('add--feature');
    expect(valid).toBe(false);
    expect(reason).toBe('double hyphens not allowed');
  });

  test('rejects branch name with spaces', () => {
    const [valid, reason] = isValidBranchName('add feature');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('rejects empty branch name', () => {
    const [valid, reason] = isValidBranchName('');
    expect(valid).toBe(false);
    expect(reason).toBe('too short');
  });

  test('rejects branch name with special characters', () => {
    const [valid, reason] = isValidBranchName('feature@test');
    expect(valid).toBe(false);
    expect(reason).toBe('invalid characters');
  });

  test('accepts exactly 50 character branch name', () => {
    const name = 'a'.repeat(50);
    const [valid, reason] = isValidBranchName(name);
    expect(valid).toBe(true);
    expect(reason).toBe('');
  });
});
