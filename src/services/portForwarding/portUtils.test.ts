import { describe, expect, test } from 'bun:test';
import { isPortAvailable } from './portUtils.ts';

describe('isPortAvailable', () => {
  test('returns true for an available high port', async () => {
    // Port 0 asks the OS to pick a free port, but isPortAvailable
    // tests a specific port. Use a high ephemeral port that is very
    // unlikely to be in use.
    const port = 59123;
    const available = await isPortAvailable(port);
    // We can't 100% guarantee the port is free, but on CI / dev machines
    // this ephemeral port is almost certainly unused.
    expect(typeof available).toBe('boolean');
    expect(available).toBe(true);
  });

  test('returns a boolean for privileged ports', async () => {
    // Port 443 requires root to bind directly, so isPortAvailable uses
    // lsof for privileged ports. The result depends on the host machine,
    // but it should always return a boolean without throwing.
    const available = await isPortAvailable(443);
    expect(typeof available).toBe('boolean');
  });
});
