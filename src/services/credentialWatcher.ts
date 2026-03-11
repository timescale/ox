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
  opencodeAuthEntryExpiresAt,
  opencodeAuthEntryValid,
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

/** Home directory inside cloud sandboxes (Deno Deploy uses /home/app). */
const CLOUD_HOME = '/home/app';

/** Credential file paths inside a sandbox, relative to the given home dir. */
function credentialFiles(agentType: AgentCredType, home: string): string[] {
  switch (agentType) {
    case 'claude':
      return [`${home}/.claude/.credentials.json`, `${home}/.claude.json`];
    case 'opencode':
      return [`${home}/.local/share/opencode/auth.json`];
    case 'codex':
      return [`${home}/.codex/auth.json`];
  }
}

/** Resolve the sandbox home directory based on provider type. */
function sandboxHome(provider: SandboxProvider): string {
  return provider.type === 'cloud' ? CLOUD_HOME : CONTAINER_HOME;
}

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
    case 'opencode':
      // Opencode uses per-key merge via mergeOpencodeCredentials() instead
      return false;
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

/**
 * Per-key merge for OpenCode credentials. Iterates each key in both objects
 * and picks the fresher OAuth entry per key. Only considers keys that are
 * OAuth entries in BOTH candidate and existing — API key entries are ignored,
 * and new keys present only in the candidate are not introduced.
 *
 * Returns the merged object if any key was updated from the candidate,
 * or null if the existing object is already up-to-date.
 */
export function mergeOpencodeCredentials(
  candidate: OpencodeAuthJson,
  existing: OpencodeAuthJson,
): OpencodeAuthJson | null {
  const merged: OpencodeAuthJson = { ...existing };
  let changed = false;

  for (const key of Object.keys(existing)) {
    const eEntry = existing[key];
    const cEntry = candidate[key];

    // Only merge oauth-to-oauth — skip api keys and missing entries
    if (!cEntry || cEntry.type !== 'oauth') continue;
    if (!eEntry || eEntry.type !== 'oauth') continue;
    if (!opencodeAuthEntryValid(cEntry)) continue;

    const cExpires = opencodeAuthEntryExpiresAt(cEntry);
    const eExpires = opencodeAuthEntryExpiresAt(eEntry);

    if (cExpires > eExpires) {
      merged[key] = cEntry;
      changed = true;
    }
  }

  return changed ? merged : null;
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
      const home = sandboxHome(entry.provider);
      const files = credentialFiles(agentType, home);

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

          // For opencode, do per-key merge instead of atomic replacement
          let toWrite: unknown;
          if (agentType === 'opencode' && hostParsed) {
            const merged = mergeOpencodeCredentials(
              parsed as OpencodeAuthJson,
              hostParsed as OpencodeAuthJson,
            );
            if (!merged) {
              log.debug(
                { sessionId, agentType },
                'credentialWatcher: no fresher opencode entries in session',
              );
              sessionFileHashes?.set(filePath, hash);
              continue;
            }
            toWrite = merged;
          } else if (
            hostParsed &&
            !isCredentialFresher(agentType, parsed, hostParsed)
          ) {
            log.debug(
              { sessionId, agentType },
              'credentialWatcher: session creds not fresher than host',
            );
            sessionFileHashes?.set(filePath, hash);
            continue;
          } else {
            toWrite = parsed;
          }

          log.info(
            { sessionId, agentType },
            'credentialWatcher: session credentials fresher, syncing back',
          );
          sessionFileHashes?.set(filePath, hash);

          // Write back to host + ox keyring
          await this.writeHostCredential(agentType, toWrite);
          await this.writeOxCredential(agentType, toWrite);

          // Update host hash so we don't re-detect our own write
          const newHostContent =
            await this.readHostCredentialContent(agentType);
          this.hostHashes.set(agentType, computeContentHash(newHostContent));

          // Push to other sessions
          const serializedToWrite = JSON.stringify(toWrite);
          await this.pushToSessions(
            agentType,
            toWrite,
            serializedToWrite,
            sessionId,
          );
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
    for (const [sessionId, entry] of this.sessions) {
      if (sessionId === excludeSessionId) continue;
      if (entry.agentType !== agentType) continue;

      const home = sandboxHome(entry.provider);
      const files = credentialFiles(agentType, home);

      for (const filePath of files) {
        try {
          // Read current session creds to check freshness
          const currentContent = await entry.provider.readFile(
            sessionId,
            filePath,
          );

          let contentToWrite = serialized;
          if (currentContent) {
            const currentParsed = this.parseCredential(currentContent);
            if (currentParsed) {
              // For opencode, merge per-key instead of atomic comparison
              if (agentType === 'opencode') {
                const merged = mergeOpencodeCredentials(
                  creds as OpencodeAuthJson,
                  currentParsed as OpencodeAuthJson,
                );
                if (!merged) {
                  log.debug(
                    { sessionId, filePath },
                    'credentialWatcher: no fresher opencode entries to push',
                  );
                  continue;
                }
                contentToWrite = JSON.stringify(merged);
              } else if (isCredentialFresher(agentType, currentParsed, creds)) {
                log.debug(
                  { sessionId, filePath },
                  'credentialWatcher: session already has fresher creds, skipping push',
                );
                continue;
              }
            }
          }

          await entry.provider.writeFile(sessionId, filePath, contentToWrite);
          log.debug(
            { sessionId, filePath },
            'credentialWatcher: pushed credentials to session',
          );

          // Update session hash so we don't re-detect the push in the next poll
          const sessionFileHashes = this.sessionHashes.get(sessionId);
          if (sessionFileHashes) {
            sessionFileHashes.set(filePath, computeContentHash(contentToWrite));
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
