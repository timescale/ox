import { describe, expect, test } from 'bun:test';
import type { HermesSession } from './sandbox/types.ts';
import {
  formatRelativeTime,
  getStatusColor,
  getStatusIcon,
  getStatusText,
} from './sessionDisplay.ts';

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

describe('formatRelativeTime', () => {
  test('returns "just now" for times less than 1 minute ago', () => {
    const date = new Date();
    date.setSeconds(date.getSeconds() - 30);
    expect(formatRelativeTime(date.toISOString())).toBe('just now');
  });

  test('returns "just now" for current time', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
  });

  test('returns minutes for times between 1 and 59 minutes', () => {
    const date = new Date();
    date.setMinutes(date.getMinutes() - 45);
    expect(formatRelativeTime(date.toISOString())).toBe('45m ago');
  });

  test('returns hours for times between 1 and 23 hours', () => {
    const date = new Date();
    date.setHours(date.getHours() - 12);
    expect(formatRelativeTime(date.toISOString())).toBe('12h ago');
  });

  test('returns days for times 24+ hours ago', () => {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    expect(formatRelativeTime(date.toISOString())).toBe('7d ago');
  });

  test('handles exactly 60 minutes as 1 hour', () => {
    const date = new Date();
    date.setMinutes(date.getMinutes() - 60);
    expect(formatRelativeTime(date.toISOString())).toBe('1h ago');
  });

  test('handles exactly 24 hours as 1 day', () => {
    const date = new Date();
    date.setHours(date.getHours() - 24);
    expect(formatRelativeTime(date.toISOString())).toBe('1d ago');
  });
});

describe('getStatusIcon', () => {
  test('returns filled circle for running', () => {
    expect(getStatusIcon(makeSession('running'))).toBe('●');
  });

  test('returns checkmark for exited with code 0', () => {
    expect(getStatusIcon(makeSession('exited', 0))).toBe('✓');
  });

  test('returns X for exited with non-zero code', () => {
    expect(getStatusIcon(makeSession('exited', 1))).toBe('✗');
  });

  test('returns X for exited with undefined exitCode', () => {
    expect(getStatusIcon(makeSession('exited', undefined))).toBe('✗');
  });

  test('returns pause icon for stopped', () => {
    expect(getStatusIcon(makeSession('stopped'))).toBe('⏸');
  });

  test('returns empty circle for unknown', () => {
    expect(getStatusIcon(makeSession('unknown'))).toBe('○');
  });
});

describe('getStatusText', () => {
  test('returns "running" for running status', () => {
    expect(getStatusText(makeSession('running'))).toBe('running');
  });

  test('returns "complete" for exited with code 0', () => {
    expect(getStatusText(makeSession('exited', 0))).toBe('complete');
  });

  test('returns "failed (N)" for exited with non-zero code', () => {
    expect(getStatusText(makeSession('exited', 1))).toBe('failed (1)');
  });

  test('returns "failed (127)" for exit code 127', () => {
    expect(getStatusText(makeSession('exited', 127))).toBe('failed (127)');
  });

  test('returns "exited" when exitCode is undefined (not "failed (undefined)")', () => {
    const text = getStatusText(makeSession('exited', undefined));
    expect(text).toBe('exited');
    expect(text).not.toContain('undefined');
  });

  test('returns "stopped" for stopped status', () => {
    expect(getStatusText(makeSession('stopped'))).toBe('stopped');
  });

  test('returns "unknown" for unknown status', () => {
    expect(getStatusText(makeSession('unknown'))).toBe('unknown');
  });
});

describe('getStatusColor', () => {
  test('returns "green" for running', () => {
    expect(getStatusColor(makeSession('running'))).toBe('green');
  });

  test('returns "blue" for exited with code 0', () => {
    expect(getStatusColor(makeSession('exited', 0))).toBe('blue');
  });

  test('returns "red" for exited with non-zero code', () => {
    expect(getStatusColor(makeSession('exited', 1))).toBe('red');
  });

  test('returns "red" for exited with undefined exitCode', () => {
    expect(getStatusColor(makeSession('exited', undefined))).toBe('red');
  });

  test('returns "yellow" for stopped', () => {
    expect(getStatusColor(makeSession('stopped'))).toBe('yellow');
  });

  test('returns "gray" for unknown', () => {
    expect(getStatusColor(makeSession('unknown'))).toBe('gray');
  });
});
