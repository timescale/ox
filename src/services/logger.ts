import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export const LOGS_DIR = '.ox/logs';
export const LOG_FILE = join(LOGS_DIR, 'ox.log');

// Lazy-initialized logger to avoid sonic-boom errors when CLI exits early (e.g., --help)
let _log: Logger | null = null;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function shouldDisableFileLogging(): boolean {
  if (isTruthyEnv(process.env.OX_DISABLE_FILE_LOGGING)) {
    return true;
  }

  if (process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test') {
    return true;
  }

  if (typeof Bun !== 'undefined' && Bun.argv.includes('test')) {
    return true;
  }

  return false;
}

export function getLogger(): Logger {
  if (!_log) {
    const logLevel = process.env.OX_LOG_LEVEL || 'info';

    if (shouldDisableFileLogging()) {
      _log = pino({
        enabled: false,
        level: logLevel,
      });
      return _log;
    }

    try {
      mkdirSync(LOGS_DIR, { recursive: true });
    } catch {
      // Ignore errors - directory may already exist
    }

    _log = pino(
      {
        level: logLevel,
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.destination({
        dest: LOG_FILE,
        sync: true,
      }),
    );
  }
  return _log;
}

// For backwards compatibility, export a proxy that lazily initializes the logger
export const log = new Proxy({} as Logger, {
  get(_target, prop) {
    return (getLogger() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
