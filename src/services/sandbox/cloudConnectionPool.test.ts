import { describe, expect, mock, test } from 'bun:test';
import type { Sandbox } from '@deno/sandbox';
import { CloudConnectionPool } from './cloudConnectionPool.ts';

// Minimal mock Sandbox for testing pool behavior
const makeMockSandbox = (opts?: { failOnRead?: boolean }) => {
  const closedResolvers = Promise.withResolvers<void>();
  return {
    sandbox: {
      fs: {
        readTextFile: mock(async (path: string) => {
          if (opts?.failOnRead) {
            const err = new Error('Connection lost');
            err.name = 'ConnectionClosedError';
            throw err;
          }
          return `content of ${path}`;
        }),
        writeTextFile: mock(async (_path: string, _content: string) => {
          if (opts?.failOnRead) {
            const err = new Error('Connection lost');
            err.name = 'ConnectionClosedError';
            throw err;
          }
        }),
        mkdir: mock(async () => {}),
      },
      close: mock(async () => {
        closedResolvers.resolve();
      }),
      get closed() {
        return closedResolvers.promise;
      },
    } as unknown as Sandbox,
    forceClose: () => closedResolvers.resolve(),
  };
};

describe('CloudConnectionPool', () => {
  test('withConnection creates a connection on first call', async () => {
    const mockSandbox = makeMockSandbox();
    const connector = mock(async () => mockSandbox.sandbox);
    const pool = new CloudConnectionPool(connector);

    const result = await pool.withConnection('session-1', async (sandbox) => {
      return sandbox.fs.readTextFile('/test');
    });

    expect(result).toBe('content of /test');
    expect(connector).toHaveBeenCalledTimes(1);
  });

  test('withConnection reuses existing connection', async () => {
    const mockSandbox = makeMockSandbox();
    const connector = mock(async () => mockSandbox.sandbox);
    const pool = new CloudConnectionPool(connector);

    await pool.withConnection('session-1', async (s) =>
      s.fs.readTextFile('/a'),
    );
    await pool.withConnection('session-1', async (s) =>
      s.fs.readTextFile('/b'),
    );

    expect(connector).toHaveBeenCalledTimes(1);
  });

  test('release closes connection and removes from pool', async () => {
    const mockSandbox = makeMockSandbox();
    const connector = mock(async () => mockSandbox.sandbox);
    const pool = new CloudConnectionPool(connector);

    await pool.withConnection('session-1', async (s) =>
      s.fs.readTextFile('/a'),
    );
    await pool.release('session-1');

    expect(mockSandbox.sandbox.close).toHaveBeenCalledTimes(1);

    // Next call creates a new connection
    const mockSandbox2 = makeMockSandbox();
    connector.mockImplementation(async () => mockSandbox2.sandbox);
    await pool.withConnection('session-1', async (s) =>
      s.fs.readTextFile('/b'),
    );
    expect(connector).toHaveBeenCalledTimes(2);
  });

  test('closeAll closes all connections', async () => {
    const mock0 = makeMockSandbox();
    const mock1 = makeMockSandbox();
    let callCount = 0;
    const connector = mock(async () => {
      const m = callCount++ === 0 ? mock0 : mock1;
      return m.sandbox;
    });
    const pool = new CloudConnectionPool(connector);

    await pool.withConnection('s1', async (s) => s.fs.readTextFile('/a'));
    await pool.withConnection('s2', async (s) => s.fs.readTextFile('/b'));
    await pool.closeAll();

    expect(mock0.sandbox.close).toHaveBeenCalledTimes(1);
    expect(mock1.sandbox.close).toHaveBeenCalledTimes(1);
  });

  test('withConnection retries once on connection error', async () => {
    const failSandbox = makeMockSandbox({ failOnRead: true });
    const goodSandbox = makeMockSandbox();
    let callCount = 0;
    const connector = mock(async () => {
      const m = callCount++ === 0 ? failSandbox : goodSandbox;
      return m.sandbox;
    });
    const pool = new CloudConnectionPool(connector);

    const result = await pool.withConnection('session-1', async (s) => {
      return s.fs.readTextFile('/test');
    });

    expect(result).toBe('content of /test');
    expect(connector).toHaveBeenCalledTimes(2);
  });
});
