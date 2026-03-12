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

  test('passes through valid appPorts array', () => {
    const result = normalizeAppPorts({
      appPorts: [{ port: 3000 }, { port: 8080, subdomain: 'api' }],
    });
    expect(result).toEqual({
      ports: [{ port: 3000 }, { port: 8080, subdomain: 'api' }],
      defaultPort: { port: 3000 },
    });
  });

  test('errors if both appPort and appPorts specified', () => {
    expect(() =>
      normalizeAppPorts({ appPort: 3000, appPorts: [{ port: 3000 }] }),
    ).toThrow('Cannot specify both appPort and appPorts');
  });

  test('errors if zero entries lack subdomain', () => {
    expect(() =>
      normalizeAppPorts({
        appPorts: [
          { port: 3000, subdomain: 'web' },
          { port: 8080, subdomain: 'api' },
        ],
      }),
    ).toThrow('At least one port entry must lack a subdomain');
  });

  test('errors if multiple entries lack subdomain', () => {
    expect(() =>
      normalizeAppPorts({
        appPorts: [{ port: 3000 }, { port: 8080 }],
      }),
    ).toThrow('Only one port entry may lack a subdomain');
  });

  test('errors on duplicate ports', () => {
    expect(() =>
      normalizeAppPorts({
        appPorts: [{ port: 3000 }, { port: 3000, subdomain: 'api' }],
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
});
