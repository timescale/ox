import { describe, expect, test } from 'bun:test';
import type { HermesSession } from '../services/docker';
import {
  formatRelativeTime,
  getStatusDisplay,
  toYaml,
  truncate,
} from './sessions';

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
    containerId: 'abc123',
    containerName: 'hermes-test',
    name: 'test',
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

  test('shows yellow for paused status', () => {
    const session = makeSession('paused');
    const display = getStatusDisplay(session);
    expect(display).toContain('paused');
    expect(display).toContain('\x1b[33m'); // yellow ANSI code
  });

  test('shows yellow for restarting status', () => {
    const session = makeSession('restarting');
    const display = getStatusDisplay(session);
    expect(display).toContain('restarting');
    expect(display).toContain('\x1b[33m'); // yellow ANSI code
  });

  test('shows red for dead status', () => {
    const session = makeSession('dead');
    const display = getStatusDisplay(session);
    expect(display).toContain('dead');
    expect(display).toContain('\x1b[31m'); // red ANSI code
  });

  test('shows cyan for created status', () => {
    const session = makeSession('created');
    const display = getStatusDisplay(session);
    expect(display).toContain('created');
    expect(display).toContain('\x1b[36m'); // cyan ANSI code
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

describe('toYaml', () => {
  test('serializes null', () => {
    expect(toYaml(null)).toBe('null');
  });

  test('serializes undefined', () => {
    expect(toYaml(undefined)).toBe('null');
  });

  test('serializes string', () => {
    expect(toYaml('hello')).toBe('hello');
  });

  test('serializes string with special characters', () => {
    const result = toYaml('key: value');
    expect(result).toContain('|-');
  });

  test('serializes multiline string', () => {
    const result = toYaml('line1\nline2');
    expect(result).toContain('|-');
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });

  test('serializes number', () => {
    expect(toYaml(42)).toBe('42');
  });

  test('serializes boolean true', () => {
    expect(toYaml(true)).toBe('true');
  });

  test('serializes boolean false', () => {
    expect(toYaml(false)).toBe('false');
  });

  test('serializes empty array', () => {
    expect(toYaml([])).toBe('[]');
  });

  test('serializes array of primitives', () => {
    const result = toYaml(['a', 'b', 'c']);
    expect(result).toContain('- a');
    expect(result).toContain('- b');
    expect(result).toContain('- c');
  });

  test('serializes empty object', () => {
    expect(toYaml({})).toBe('{}');
  });

  test('serializes object with primitive values', () => {
    const result = toYaml({ name: 'test', count: 5 });
    expect(result).toContain('name: test');
    expect(result).toContain('count: 5');
  });

  test('serializes nested object', () => {
    const result = toYaml({ outer: { inner: 'value' } });
    expect(result).toContain('outer:');
    expect(result).toContain('inner: value');
  });

  test('serializes array of objects', () => {
    const result = toYaml([{ name: 'first' }, { name: 'second' }]);
    expect(result).toContain('- name: first');
    expect(result).toContain('- name: second');
  });

  test('serializes complex session-like object', () => {
    const session = {
      name: 'test-session',
      status: 'running',
      agent: 'opencode',
      exitCode: 0,
    };
    const result = toYaml(session);
    expect(result).toContain('name: test-session');
    expect(result).toContain('status: running');
    expect(result).toContain('agent: opencode');
    expect(result).toContain('exitCode: 0');
  });
});
