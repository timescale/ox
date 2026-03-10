import type { Sandbox } from '@deno/sandbox';
import { log } from '../logger.ts';

/**
 * Creates a new Sandbox WebSocket connection for a given session ID.
 */
type SandboxConnector = (sessionId: string) => Promise<Sandbox>;

/**
 * Manages persistent WebSocket connections to cloud sandboxes.
 *
 * Connections are created on first use, reused across calls, and
 * automatically removed when the server closes them. If a call
 * fails with a connection error, the pool retries once with a
 * fresh connection.
 *
 * Follows the same keep-alive pattern as streamLogs in cloudProvider.ts.
 */
export class CloudConnectionPool {
  private connections = new Map<string, Sandbox>();
  private connecting = new Map<string, Promise<Sandbox>>();
  private connector: SandboxConnector;

  constructor(connector: SandboxConnector) {
    this.connector = connector;
  }

  /**
   * Borrow a connection for a session, executing `fn` with it.
   * Creates a connection on first use. Retries once with a fresh
   * connection if `fn` throws a connection error.
   */
  async withConnection<T>(
    sessionId: string,
    fn: (sandbox: Sandbox) => Promise<T>,
  ): Promise<T> {
    const sandbox = await this.getOrConnect(sessionId);
    try {
      return await fn(sandbox);
    } catch (err) {
      if (this.isConnectionError(err)) {
        log.debug({ sessionId, err }, 'Cloud connection error, reconnecting');
        this.removeConnection(sessionId);
        const fresh = await this.getOrConnect(sessionId);
        return fn(fresh);
      }
      throw err;
    }
  }

  /** Close and remove a specific session's connection. */
  async release(sessionId: string): Promise<void> {
    const sandbox = this.connections.get(sessionId);
    this.connections.delete(sessionId);
    this.connecting.delete(sessionId);
    if (sandbox) {
      try {
        await sandbox.close();
      } catch (err) {
        log.debug({ err, sessionId }, 'Error closing cloud connection');
      }
    }
  }

  /** Close all connections. */
  async closeAll(): Promise<void> {
    const entries = [...this.connections.entries()];
    this.connections.clear();
    this.connecting.clear();
    await Promise.allSettled(
      entries.map(async ([sessionId, sandbox]) => {
        try {
          await sandbox.close();
        } catch (err) {
          log.debug({ err, sessionId }, 'Error closing cloud connection');
        }
      }),
    );
  }

  /** Number of active connections (for diagnostics). */
  get size(): number {
    return this.connections.size;
  }

  private async getOrConnect(sessionId: string): Promise<Sandbox> {
    const existing = this.connections.get(sessionId);
    if (existing) return existing;

    // If a connection attempt is already in progress, wait for it
    const pending = this.connecting.get(sessionId);
    if (pending) return pending;

    const connectPromise = this.connect(sessionId);
    this.connecting.set(sessionId, connectPromise);
    try {
      const sandbox = await connectPromise;
      this.connections.set(sessionId, sandbox);

      // Auto-remove when the server closes the connection
      void sandbox.closed.then(() => {
        log.debug({ sessionId }, 'Cloud connection closed by server');
        this.removeConnection(sessionId);
      });

      return sandbox;
    } finally {
      this.connecting.delete(sessionId);
    }
  }

  private async connect(sessionId: string): Promise<Sandbox> {
    log.debug({ sessionId }, 'Opening pooled cloud connection');
    return this.connector(sessionId);
  }

  private removeConnection(sessionId: string): void {
    this.connections.delete(sessionId);
  }

  private isConnectionError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: string }).name;
    const message = (err as { message?: string }).message ?? '';
    return (
      name === 'ConnectionClosedError' ||
      message.includes('ConnectionClosed') ||
      message.includes('Connection lost') ||
      message.includes('SANDBOX_ALREADY_TERMINATED') ||
      message.includes('SANDBOX_NOT_FOUND')
    );
  }
}
