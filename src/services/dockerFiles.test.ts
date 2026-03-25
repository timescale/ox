import { describe, expect, test } from 'bun:test';
import { buildWriteFileCommand, isStrictPermissionFile } from './dockerFiles';

describe('isStrictPermissionFile', () => {
  test('returns true for .pgpass paths', () => {
    expect(isStrictPermissionFile('/home/ox/.pgpass')).toBe(true);
    expect(isStrictPermissionFile('/tmp/.pgpass')).toBe(true);
  });

  test('returns false for other files', () => {
    expect(isStrictPermissionFile('/home/ox/.config/gh/hosts.yml')).toBe(false);
    expect(isStrictPermissionFile('/home/ox/.config/ghost/credentials')).toBe(
      false,
    );
  });
});

describe('buildWriteFileCommand', () => {
  test('adds chmod 600 for .pgpass files', () => {
    expect(buildWriteFileCommand('/home/ox/.pgpass')).toContain(
      'chmod 600 /home/ox/.pgpass',
    );
  });

  test('does not add chmod 600 for normal files', () => {
    expect(
      buildWriteFileCommand('/home/ox/.config/gh/hosts.yml'),
    ).not.toContain('chmod 600');
  });
});
