import { describe, expect, test } from 'bun:test';
import { normalizeAppPorts } from './config.ts';

describe('normalizeAppPorts', () => {
  test('returns null when no config present', () => {
    expect(normalizeAppPorts({})).toBeNull();
  });

  test('normalizes appPort shorthand to array', () => {
    const result = normalizeAppPorts({ appPort: 3000 });
    expect(result).toEqual({
      ports: [{ port: 3000 }],
      defaultPort: { port: 3000 },
    });
  });

  test('appPort with additionalPorts combines correctly', () => {
    const result = normalizeAppPorts({
      appPort: 3000,
      additionalPorts: [{ port: 8080, subdomain: 'api' }],
    });
    expect(result).toEqual({
      ports: [{ port: 3000 }, { port: 8080, subdomain: 'api' }],
      defaultPort: { port: 3000 },
    });
  });

  test('additionalPorts without appPort is an error', () => {
    expect(() =>
      normalizeAppPorts({
        additionalPorts: [{ port: 8080, subdomain: 'api' }],
      }),
    ).toThrow('appPort is required when using additionalPorts');
  });

  test('additionalPorts entry missing subdomain is an error', () => {
    expect(() =>
      normalizeAppPorts({
        appPort: 3000,
        additionalPorts: [{ port: 8080, subdomain: '' }],
      }),
    ).toThrow('must have a non-empty subdomain');
  });

  test('errors on duplicate ports', () => {
    expect(() =>
      normalizeAppPorts({
        appPort: 3000,
        additionalPorts: [{ port: 3000, subdomain: 'api' }],
      }),
    ).toThrow('Duplicate port number: 3000');
  });

  test('errors on invalid port number (0)', () => {
    expect(() => normalizeAppPorts({ appPort: 0 })).toThrow(
      'Invalid port number: 0',
    );
  });

  test('errors on invalid port number (70000)', () => {
    expect(() => normalizeAppPorts({ appPort: 70000 })).toThrow(
      'Invalid port number: 70000',
    );
  });

  test('errors on invalid additional port number', () => {
    expect(() =>
      normalizeAppPorts({
        appPort: 3000,
        additionalPorts: [{ port: 0, subdomain: 'api' }],
      }),
    ).toThrow('Invalid port number: 0');
  });
});
