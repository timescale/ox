import { describe, expect, test } from 'bun:test';
import { isNewer } from './updater';

describe('isNewer', () => {
  test('returns true when major version is higher', () => {
    expect(isNewer('2.0.0', '1.0.0')).toBe(true);
  });

  test('returns true when minor version is higher', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
  });

  test('returns true when patch version is higher', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
  });

  test('returns false when versions are equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  test('returns false when major version is lower', () => {
    expect(isNewer('1.0.0', '2.0.0')).toBe(false);
  });

  test('returns false when minor version is lower', () => {
    expect(isNewer('1.0.0', '1.1.0')).toBe(false);
  });

  test('returns false when patch version is lower', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  test('handles realistic version bumps', () => {
    expect(isNewer('0.10.2', '0.10.1')).toBe(true);
    expect(isNewer('0.11.0', '0.10.1')).toBe(true);
    expect(isNewer('1.0.0', '0.10.1')).toBe(true);
  });

  test('handles versions with different segment counts', () => {
    expect(isNewer('1.0', '0.9.9')).toBe(true);
    expect(isNewer('1', '0.9.9')).toBe(true);
  });
});
