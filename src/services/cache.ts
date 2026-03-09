import type {
  ClaudeCredentialsJson,
  CodexAuthJson,
  OpencodeAuthJson,
} from '../types/agentConfig';

interface CacheItems {
  claudeCredentialsJson: ClaudeCredentialsJson | null;
  claudeApiKey: string | null;
  opencodeAuthJson: OpencodeAuthJson;
  codexAuthJson: CodexAuthJson | null;
}

interface CacheRecord<K extends keyof CacheItems = keyof CacheItems> {
  value: CacheItems[K];
  timestamp: number;
  ttl: number;
}

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

const cache = new Map<keyof CacheItems, CacheRecord>();

export const writeCache = <K extends keyof CacheItems>(
  key: K,
  value: CacheItems[K],
  ttl = DEFAULT_TTL,
): void => {
  cache.set(key, {
    value,
    timestamp: Date.now(),
    ttl,
  });
};

export const readCache = <K extends keyof CacheItems>(
  key: K,
): CacheRecord<K> | null => {
  const record = cache.get(key);
  if (!record) return null;
  if (Date.now() - record.timestamp > record.ttl) {
    cache.delete(key);
    return null;
  }
  return record as CacheRecord<K>;
};

export const clearCache = (): void => {
  cache.clear();
};

export const deleteCache = <K extends keyof CacheItems>(key: K): void => {
  cache.delete(key);
};
