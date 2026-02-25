import { describe, expect, test } from 'bun:test';
import { isSandboxTerminatedError } from './cloudProvider.ts';

describe('isSandboxTerminatedError', () => {
  test('detects SANDBOX_ALREADY_TERMINATED code', () => {
    const err = { code: 'SANDBOX_ALREADY_TERMINATED', message: 'terminated' };
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('detects SANDBOX_NOT_FOUND code', () => {
    const err = { code: 'SANDBOX_NOT_FOUND', message: 'not found' };
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('detects by message fallback', () => {
    const err = new Error('The requested sandbox has already been terminated.');
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isSandboxTerminatedError(new Error('network timeout'))).toBe(false);
    expect(isSandboxTerminatedError(null)).toBe(false);
    expect(isSandboxTerminatedError(undefined)).toBe(false);
  });

  test('returns false for numeric code (not string)', () => {
    const err = { code: 404, message: 'not found' };
    expect(isSandboxTerminatedError(err)).toBe(false);
  });
});
