import { createHash } from 'node:crypto';
import type {
  ClaudeCredentialsJson,
  CodexAuthJson,
  OpencodeAuthJson,
} from '../types/agentConfig.ts';
import { Deferred } from '../types/deferred.ts';
import {
  claudeCredsValid,
  readHostClaudeCredentials,
  writeHostClaudeCredentials,
  writeOxClaudeCredentials,
} from './claude.ts';
import {
  codexCredsValid,
  readHostCodexCredentials,
  writeHostCodexCredentials,
  writeOxCodexCredentials,
} from './codex.ts';
import { CONTAINER_HOME } from './dockerFiles.ts';
import { log } from './logger.ts';
import {
  opencodeCredsValid,
  readHostOpencodeCredentials,
  writeHostOpencodeCredentials,
  writeOxOpencodeCredentials,
} from './opencode.ts';
import type { OxSession, SandboxProvider } from './sandbox/types.ts';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

export type AgentCredType = 'claude' | 'opencode' | 'codex';

interface RegisteredSession {
  sessionId: string;
  provider: SandboxProvider;
  agentType: string;
}

/** Credential file paths inside the sandbox container */
const CREDENTIAL_FILES: Record<AgentCredType, string[]> = {
  claude: [
    `${CONTAINER_HOME}/.claude/.credentials.json`,
    `${CONTAINER_HOME}/.claude.json`,
  ],
  opencode: [`${CONTAINER_HOME}/.local/share/opencode/auth.json`],
  codex: [`${CONTAINER_HOME}/.codex/auth.json`],
};

const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Exported utility functions (for testing)
// ---------------------------------------------------------------------------

export function computeContentHash(content: string | null | undefined): string {
  if (!content) return '';
  return createHash('sha256').update(content).digest('hex');
}

export function isCredentialFresher(
  agentType: AgentCredType,
  candidate: unknown,
  existing: unknown,
): boolean {
  switch (agentType) {
    case 'claude': {
      const c = candidate as ClaudeCredentialsJson;
      const e = existing as ClaudeCredentialsJson;
      const cExpires = c?.claudeAiOauth?.expiresAt ?? 0;
      const eExpires = e?.claudeAiOauth?.expiresAt ?? 0;
      if (cExpires === 0 && eExpires > 0) return false;
      return cExpires > eExpires;
    }
    case 'opencode': {
      const c = candidate as OpencodeAuthJson;
      const e = existing as OpencodeAuthJson;
      const maxExpires = (auth: OpencodeAuthJson): number => {
        let max = 0;
        for (const entry of Object.values(auth ?? {})) {
          if (entry?.type === 'oauth' && entry.expires) {
            max = Math.max(max, entry.expires);
          }
        }
        return max;
      };
      return maxExpires(c) > maxExpires(e);
    }
    case 'codex': {
      const c = candidate as CodexAuthJson;
      const e = existing as CodexAuthJson;
      // Nested tokens format has no expires — treat as always fresh
      if (c?.tokens && !c?.expires_at) return true;
      const cExpires = c?.expires_at ?? 0;
      const eExpires = e?.expires_at ?? 0;
      return cExpires > eExpires;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// AsyncMutex — simple per-key lock to prevent concurrent credential writes
// ---------------------------------------------------------------------------

class AsyncMutex {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    const deferred = new Deferred<void>();
    this.locks.set(key, deferred.promise);
    return () => {
      this.locks.delete(key);
      deferred.resolve();
    };
  }
}

// ---------------------------------------------------------------------------
// CredentialWatcher
// ---------------------------------------------------------------------------

class CredentialWatcher {
  /** Registered sessions keyed by sessionId */
  private sessions = new Map<string, RegisteredSession>();

  /** Last-known hashes for host credential sources, keyed by AgentCredType */
  private hostHashes = new Map<AgentCredType, string>();

  /** Per-session hashes: sessionId → (filePath → hash) */
  private sessionHashes = new Map<string, Map<string, string>>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private mutex = new AsyncMutex();

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  register(
    session: OxSession,
    provider: SandboxProvider,
    _initialCredentials?: unknown,
  ): void {
    const entry: RegisteredSession = {
      sessionId: session.id,
      provider,
      agentType: session.agent,
    };
    this.sessions.set(session.id, entry);
    this.sessionHashes.set(session.id, new Map());
    log.debug(
      { sessionId: session.id, agent: session.agent },
      'credentialWatcher: registered session',
    );

    if (!this.running) {
      this.start();
    }
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionHashes.delete(sessionId);
    log.debug({ sessionId }, 'credentialWatcher: unregistered session');

    if (this.sessions.size === 0) {
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    log.debug('credentialWatcher: stopped');
  }

  // -----------------------------------------------------------------------
  // Poll loop
  // -----------------------------------------------------------------------

  private start(): void {
    if (this.running) return;
    this.running = true;
    // Trigger an initial poll immediately (fire-and-forget)
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    log.debug('credentialWatcher: started');
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // prevent overlapping polls
    this.polling = true;
    try {
      await this.pollHostSources();
      await this.pollSessions();
    } catch (err) {
      log.error({ err }, 'credentialWatcher: poll error');
    } finally {
      this.polling = false;
    }
  }

  // -----------------------------------------------------------------------
  // Phase 1: Host → Sessions
  // -----------------------------------------------------------------------

  private async pollHostSources(): Promise<void> {
    const agentTypes: AgentCredType[] = ['claude', 'opencode', 'codex'];
    for (const agentType of agentTypes) {
      const release = await this.mutex.acquire(`host:${agentType}`);
      try {
        const content = await this.readHostCredentialContent(agentType);
        const hash = computeContentHash(content);
        const prevHash = this.hostHashes.get(agentType);

        if (prevHash === undefined) {
          // First poll — just record the hash, don't trigger changes
          this.hostHashes.set(agentType, hash);
          continue;
        }

        if (hash === prevHash || !content) continue;

        // Host changed — validate before propagating
        const parsed = this.parseCredential(content);
        if (!parsed || !this.validateCredential(agentType, parsed)) {
          log.debug(
            { agentType },
            'credentialWatcher: host creds changed but invalid, skipping',
          );
          this.hostHashes.set(agentType, hash);
          continue;
        }

        log.info(
          { agentType },
          'credentialWatcher: host credentials changed, propagating',
        );
        this.hostHashes.set(agentType, hash);

        // Write to ox keyring
        await this.writeOxCredential(agentType, parsed);

        // Push to all sessions
        await this.pushToSessions(agentType, parsed, content);
      } catch (err) {
        log.error(
          { err, agentType },
          'credentialWatcher: pollHostSources error',
        );
      } finally {
        release();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Sessions → Host
  // -----------------------------------------------------------------------

  private async pollSessions(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      // Check if session is still running
      try {
        const session = await entry.provider.get(sessionId);
        if (!session || session.status !== 'running') {
          log.debug(
            { sessionId },
            'credentialWatcher: session no longer running, unregistering',
          );
          this.unregister(sessionId);
          continue;
        }
      } catch {
        log.debug(
          { sessionId },
          'credentialWatcher: failed to check session status, unregistering',
        );
        this.unregister(sessionId);
        continue;
      }

      const agentType = entry.agentType as AgentCredType;
      const files = CREDENTIAL_FILES[agentType];
      if (!files) continue;

      for (const filePath of files) {
        const release = await this.mutex.acquire(
          `session:${sessionId}:${filePath}`,
        );
        try {
          let content: string | null = null;
          try {
            content = await entry.provider.readFile(sessionId, filePath);
          } catch {
            continue; // File doesn't exist or read failed
          }

          const hash = computeContentHash(content);
          const sessionFileHashes = this.sessionHashes.get(sessionId);
          const prevHash = sessionFileHashes?.get(filePath);

          if (prevHash === undefined) {
            // First poll — just record the hash
            sessionFileHashes?.set(filePath, hash);
            continue;
          }

          if (hash === prevHash || !content) continue;

          // Session file changed
          const parsed = this.parseCredential(content);
          if (!parsed || !this.validateCredential(agentType, parsed)) {
            log.debug(
              { sessionId, filePath },
              'credentialWatcher: session creds changed but invalid',
            );
            sessionFileHashes?.set(filePath, hash);
            continue;
          }

          // Check if this is fresher than what the host has
          const hostContent = await this.readHostCredentialContent(agentType);
          const hostParsed = hostContent
            ? this.parseCredential(hostContent)
            : null;

          if (
            hostParsed &&
            !isCredentialFresher(agentType, parsed, hostParsed)
          ) {
            log.debug(
              { sessionId, agentType },
              'credentialWatcher: session creds not fresher than host',
            );
            sessionFileHashes?.set(filePath, hash);
            continue;
          }

          log.info(
            { sessionId, agentType },
            'credentialWatcher: session credentials fresher, syncing back',
          );
          sessionFileHashes?.set(filePath, hash);

          // Write back to host + ox keyring
          await this.writeHostCredential(agentType, parsed);
          await this.writeOxCredential(agentType, parsed);

          // Update host hash so we don't re-detect our own write
          const newHostContent =
            await this.readHostCredentialContent(agentType);
          this.hostHashes.set(agentType, computeContentHash(newHostContent));

          // Push to other sessions
          await this.pushToSessions(agentType, parsed, content, sessionId);
        } catch (err) {
          log.error(
            { err, sessionId, filePath },
            'credentialWatcher: pollSessions error',
          );
        } finally {
          release();
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async readHostCredentialContent(
    agentType: AgentCredType,
  ): Promise<string | null> {
    try {
      let creds: unknown;
      switch (agentType) {
        case 'claude':
          creds = await readHostClaudeCredentials();
          break;
        case 'opencode':
          creds = await readHostOpencodeCredentials();
          break;
        case 'codex':
          creds = await readHostCodexCredentials();
          break;
      }
      return creds ? JSON.stringify(creds) : null;
    } catch (err) {
      log.debug(
        { err, agentType },
        'credentialWatcher: failed to read host credentials',
      );
      return null;
    }
  }

  private parseCredential(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private validateCredential(
    agentType: AgentCredType,
    parsed: unknown,
  ): boolean {
    switch (agentType) {
      case 'claude':
        return claudeCredsValid(parsed as ClaudeCredentialsJson);
      case 'opencode':
        return opencodeCredsValid(parsed as OpencodeAuthJson);
      case 'codex':
        return codexCredsValid(parsed as CodexAuthJson);
      default:
        return false;
    }
  }

  private async writeHostCredential(
    agentType: AgentCredType,
    creds: unknown,
  ): Promise<void> {
    try {
      switch (agentType) {
        case 'claude':
          await writeHostClaudeCredentials(creds as ClaudeCredentialsJson);
          break;
        case 'opencode':
          await writeHostOpencodeCredentials(creds as OpencodeAuthJson);
          break;
        case 'codex':
          await writeHostCodexCredentials(creds as CodexAuthJson);
          break;
      }
    } catch (err) {
      log.warn(
        { err, agentType },
        'credentialWatcher: failed to write host credentials',
      );
    }
  }

  private async writeOxCredential(
    agentType: AgentCredType,
    creds: unknown,
  ): Promise<void> {
    try {
      switch (agentType) {
        case 'claude':
          await writeOxClaudeCredentials(creds as ClaudeCredentialsJson);
          break;
        case 'opencode':
          await writeOxOpencodeCredentials(creds as OpencodeAuthJson);
          break;
        case 'codex':
          await writeOxCodexCredentials(creds as CodexAuthJson);
          break;
      }
    } catch (err) {
      log.warn(
        { err, agentType },
        'credentialWatcher: failed to write ox credentials',
      );
    }
  }

  /**
   * Push credentials to all registered sessions of the matching agent type.
   * Before writing, reads the session's current creds and checks freshness.
   * Skips sessions that already have fresher credentials.
   * After pushing, updates session hashes so the push isn't re-detected.
   *
   * @param excludeSessionId - Session to skip (the source of the change)
   */
  private async pushToSessions(
    agentType: AgentCredType,
    creds: unknown,
    serialized: string,
    excludeSessionId?: string,
  ): Promise<void> {
    const files = CREDENTIAL_FILES[agentType];
    if (!files) return;

    for (const [sessionId, entry] of this.sessions) {
      if (sessionId === excludeSessionId) continue;
      if (entry.agentType !== agentType) continue;

      for (const filePath of files) {
        try {
          // Read current session creds to check freshness
          const currentContent = await entry.provider.readFile(
            sessionId,
            filePath,
          );
          if (currentContent) {
            const currentParsed = this.parseCredential(currentContent);
            if (
              currentParsed &&
              isCredentialFresher(agentType, currentParsed, creds)
            ) {
              log.debug(
                { sessionId, filePath },
                'credentialWatcher: session already has fresher creds, skipping push',
              );
              continue;
            }
          }

          await entry.provider.writeFile(sessionId, filePath, serialized);
          log.debug(
            { sessionId, filePath },
            'credentialWatcher: pushed credentials to session',
          );

          // Update session hash so we don't re-detect the push in the next poll
          const sessionFileHashes = this.sessionHashes.get(sessionId);
          if (sessionFileHashes) {
            sessionFileHashes.set(filePath, computeContentHash(serialized));
          }
        } catch (err) {
          log.warn(
            { err, sessionId, filePath },
            'credentialWatcher: failed to push to session',
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const credentialWatcher = new CredentialWatcher();
