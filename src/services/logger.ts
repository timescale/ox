import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

export const LOGS_DIR = '.hermes/logs';
export const LOG_FILE = join(LOGS_DIR, 'hermes.log');

try {
  mkdirSync(LOGS_DIR, { recursive: true });
} catch {
  // Ignore errors - directory may already exist
}

export const log = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({
    dest: LOG_FILE,
  }),
);
