import { describe, expect, test } from 'bun:test';
import type { HermesSession } from '../services/sandbox';
import { formatRelativeTime } from '../services/sessionDisplay';
import { getStatusDisplay, truncate } from './sessions';

describe('formatRelativeTime', () => {
  test('returns "just now" for very recent time', () => {
    const now = new Date().toISOString();
    const result = formatRelativeTime(now);
    expect(result).toBe('just now');
  });

  test('returns minutes ago for times under an hour', () => {
    const date = new Date();
    date.setMinutes(date.getMinutes() - 5);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('5m ago');
  });

  test('returns hours ago for times under a day', () => {
    const date = new Date();
    date.setHours(date.getHours() - 3);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('3h ago');
  });

  test('returns days ago for times over a day', () => {
    const date = new Date();
    date.setDate(date.getDate() - 2);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('2d ago');
  });

  test('handles 1 minute ago', () => {
    const date = new Date();
    date.setMinutes(date.getMinutes() - 1);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('1m ago');
  });

  test('handles 1 hour ago', () => {
    const date = new Date();
    date.setHours(date.getHours() - 1);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('1h ago');
  });

  test('handles 1 day ago', () => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('1d ago');
  });

  test('handles many days ago', () => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    const result = formatRelativeTime(date.toISOString());
    expect(result).toBe('30d ago');
  });
});

describe('getStatusDisplay', () => {
  const makeSession = (
    status: HermesSession['status'],
    exitCode?: number,
  ): HermesSession => ({
    id: 'abc123',
    name: 'test',
    provider: 'docker',
    branch: 'test',
    agent: 'opencode',
    repo: 'owner/repo',
    prompt: 'test prompt',
    created: new Date().toISOString(),
    interactive: false,
    status,
    exitCode,
  });

  test('shows green for running status', () => {
    const session = makeSession('running');
    const display = getStatusDisplay(session);
    expect(display).toContain('running');
    expect(display).toContain('\x1b[32m'); // green ANSI code
  });

  test('shows blue for complete (exited with code 0)', () => {
    const session = makeSession('exited', 0);
    const display = getStatusDisplay(session);
    expect(display).toContain('complete');
    expect(display).toContain('\x1b[34m'); // blue ANSI code
  });

  test('shows red for failed (exited with non-zero code)', () => {
    const session = makeSession('exited', 1);
    const display = getStatusDisplay(session);
    expect(display).toContain('failed');
    expect(display).toContain('(1)');
    expect(display).toContain('\x1b[31m'); // red ANSI code
  });

  test('shows exit code in failed status', () => {
    const session = makeSession('exited', 127);
    const display = getStatusDisplay(session);
    expect(display).toContain('(127)');
  });

  test('shows yellow for stopped status', () => {
    const session = makeSession('stopped');
    const display = getStatusDisplay(session);
    expect(display).toContain('stopped');
    expect(display).toContain('\x1b[33m'); // yellow ANSI code
  });

  test('shows gray for unknown status', () => {
    const session = makeSession('unknown');
    const display = getStatusDisplay(session);
    expect(display).toContain('unknown');
    expect(display).toContain('\x1b[90m'); // gray ANSI code
  });

  test('shows yellow "exited" when exitCode is undefined (not "failed (undefined)")', () => {
    const session = makeSession('exited', undefined);
    const display = getStatusDisplay(session);
    expect(display).toContain('exited');
    expect(display).toContain('\x1b[33m'); // yellow ANSI code
    expect(display).not.toContain('undefined');
    expect(display).not.toContain('failed');
  });
});

describe('truncate', () => {
  test('returns string unchanged if shorter than maxLen', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('returns string unchanged if equal to maxLen', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  test('truncates and adds ellipsis when string is longer', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  test('handles very short maxLen', () => {
    expect(truncate('hello', 4)).toBe('h...');
  });

  test('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  test('handles maxLen of 3 (minimum for ellipsis)', () => {
    expect(truncate('hello', 3)).toBe('...');
  });
});
