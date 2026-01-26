// ============================================================================
// Logs Command - Display hermes logs with pino-pretty formatting
// ============================================================================

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { prettyFactory } from 'pino-pretty';
import { Tail } from 'tail';
import { LOG_FILE } from '../services/logger';

interface LogsOptions {
  follow?: boolean;
}

// Create a prettifier function
const prettify = prettyFactory({ colorize: true });

export async function logsAction(options: LogsOptions): Promise<void> {
  const logFile = Bun.file(LOG_FILE);

  if (!(await logFile.exists())) {
    console.error(`Log file not found: ${LOG_FILE}`);
    process.exit(1);
  }

  if (options.follow) {
    // Use tail library to follow the log file
    const tail = new Tail(LOG_FILE, { fromBeginning: true, follow: true });

    tail.on('line', (line: string) => {
      if (line.trim()) {
        process.stdout.write(prettify(line));
      }
    });

    tail.on('error', (error: Error) => {
      console.error(`Error tailing log file: ${error.message}`);
      process.exit(1);
    });

    // Handle Ctrl-C gracefully
    process.on('SIGINT', () => {
      tail.unwatch();
      process.exit(0);
    });
  } else {
    // Read and prettify existing logs using readline
    const stream = createReadStream(LOG_FILE);
    const rl = createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    for await (const line of rl) {
      if (line.trim()) {
        process.stdout.write(prettify(line));
      }
    }
  }
}

export const logsCommand = new Command('logs')
  .description('Display hermes logs with pretty formatting')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .action(logsAction);
